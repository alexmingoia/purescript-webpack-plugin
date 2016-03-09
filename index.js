'use strict';

var path = require('path');

var fs = require('fs');

var child_process = require('child_process');

var debug = require('debug')('purescript-webpack-plugin');

var fileGlobber = require('./file-globber');

var modificationMap = require('./modification-map');

var moduleMap = require('./module-map');

var dependencyGraph = require('./dependency-graph');

var moduleParser = require('./module-parser');

var PSC = 'psc';

var PSC_BUNDLE = 'psc-bundle';

var REQUIRE_PATH = '../';

var PURS = '.purs';

function PurescriptWebpackPlugin(options) {
  this.options = Object.assign({
    src: [
      path.join('src', '**', '*.purs'),
      path.join('bower_components', 'purescript-*', 'src', '**', '*.purs')
    ],
    ffi: [
      path.join('src', '**', '*.js'),
      path.join('bower_components', 'purescript-*', 'src', '**', '*.js')
    ],
    output: 'output',
    bundleOutput: path.join('output', 'bundle.js'),
    bundleNamespace: 'PS',
    bundle: true
  }, options);

  this.context = {
    options: this.options
  };

  this.cache = {
    srcFiles: [],
    ffiFiles: [],
    srcModificationMap: modificationMap.emptyMap(),
    ffiModificationMap: modificationMap.emptyMap(),
    srcModuleMap: moduleMap.emptyMap(),
    ffiModuleMap: moduleMap.emptyMap(),
    dependencyGraph: dependencyGraph.emptyGraph()
  };
}

PurescriptWebpackPlugin.prototype.bundleModuleNames = function(){
  var entries = this.context.bundleEntries;

  var modules = this.context.compilation.modules;

  var moduleNames = entries.map(function(entry){
    var module_ = modules.filter(function(module_){
      return module_.userRequest === entry.userRequest;
    });

    if (!module_[0]) return null;
    else {
      var file = module_[0].resource;

      var result = moduleParser.srcNameSync(file);

      return result;
    }
  });

  var nonNullNames = moduleNames.filter(function(name){ return name !== null; });

  return nonNullNames;
};

PurescriptWebpackPlugin.prototype.bundle = function(callback){
  var moduleNames = this.bundleModuleNames();

  if (moduleNames.length === 0) callback(new Error("No entry point module names found."), null);
  else {
    var moduleArgs = moduleNames.reduce(function(b, a){ return b.concat(['-m', a]); }, []);

    var args = moduleArgs.concat([
      '-n', this.options.bundleNamespace,
      '-r', REQUIRE_PATH,
      path.join(this.options.output, '**', 'index.js'),
      path.join(this.options.output, '**', 'foreign.js')
    ]);

    var psc = child_process.spawn(PSC_BUNDLE, args);

    var stdout = '';

    var stderr = '';

    psc.stdout.on('data', function(data){
      stdout = stdout + data.toString();
    });

    psc.stderr.on('data', function(data){
      stderr = stderr + data.toString();
    });

    psc.on('close', function(code){
      var error = code !== 0 ? new Error(stderr) : null;
      callback(error, stdout);
    });
  }
};

PurescriptWebpackPlugin.prototype.compile = function(callback){
  var ffiArgs = this.options.ffi.reduce(function(b, a){ return b.concat(['-f', a]); }, []);

  var args = ffiArgs.concat([
    '-o', this.options.output,
    '-r', REQUIRE_PATH
  ]).concat(this.options.src);

  var psc = child_process.spawn(PSC, args);

  var stderr = '';

  psc.stderr.on('data', function(data){
    stderr = stderr + data.toString();
  });

  psc.on('close', function(code){
    var error = code !== 0 ? new Error(stderr) : null;
    callback(error);
  });
};

PurescriptWebpackPlugin.prototype.updateDependencies = function(bundle, callback){
  var plugin = this;

  var options = plugin.options;

  var cache = plugin.cache;

  plugin.scanFiles(function(error, result){
    moduleMap.insertSrc(result.srcFiles, cache.srcModuleMap, cache.srcModificationMap, result.srcModificationMap, function(error, srcMap){
      if (error) callback(error, cache);
      else {
        moduleMap.insertFFI(result.ffiFiles, cache.ffiModuleMap, cache.ffiModificationMap, result.ffiModificationMap, function(error, ffiMap){
          if (error) callback(error, cache);
          else {
            dependencyGraph.insertFromBundle(bundle, options.bundleNamespace, dependencyGraph.emptyGraph(), function(error, graph){
              if (error) callback(error, cache);
              else {
                var result_ = {
                  srcFiles: result.srcFiles,
                  ffiFiles: result.ffiFiles,
                  srcModificationMap: result.srcModificationMap,
                  ffiModificationMap: result.ffiModificationMap,
                  srcModuleMap: srcMap,
                  ffiModuleMap: ffiMap,
                  dependencyGraph: graph
                };

                callback(null, result_);
              }
            });
          }
        });
      }
    });
  });
};

PurescriptWebpackPlugin.prototype.scanFiles = function(callback){
  var plugin = this;

  fileGlobber.glob(plugin.options.src, function(error, srcs){
    if (error) callback(error, null);
    else {
      fileGlobber.glob(plugin.options.ffi, function(error, ffis){
        if (error) callback(error, null);
        else {
          modificationMap.insert(srcs, modificationMap.emptyMap(), function(error, srcMap){
            if (error) callback(error, null);
            else {
              modificationMap.insert(ffis, modificationMap.emptyMap(), function(error, ffiMap){
                if (error) callback(error, null);
                else {
                  var result = {
                    srcFiles: srcs,
                    ffiFiles: ffis,
                    srcModificationMap: srcMap,
                    ffiModificationMap: ffiMap
                  };

                  callback(null, result);
                }
              });
            }
          });
        }
      });
    }
  });
};

PurescriptWebpackPlugin.prototype.contextCompile = function(callback){
  var plugin = this;

  return function(){
    var callbacks = plugin.context.callbacks;

    callbacks.push(callback);

    var invokeCallbacks = function(error, result){
      callbacks.forEach(function(callback){
        callback(error)(result)()
      });
    };

    var cache = {
      srcMap: plugin.cache.srcModuleMap,
      ffiMap: plugin.cache.ffiModuleMap,
      graph: plugin.cache.dependencyGraph
    };

    if (plugin.context.requiresCompiling) {
      plugin.context.requiresCompiling = false;

      debug('Compiling PureScript files');

      plugin.compile(function(error){
        if (error) invokeCallbacks(error, cache);
        else if (plugin.options.bundle) {
          debug('Bundling compiled PureScript files');

          plugin.bundle(function(error, bundle){
            if (error) invokeCallbacks(error, cache);
            else {
              debug('Updating dependency graph of PureScript bundle');

              plugin.updateDependencies(bundle, function(error, result){
                var cache_ = {
                  srcMap: result.srcModuleMap,
                  ffiMap: result.ffiModuleMap,
                  graph: result.dependencyGraph
                };

                Object.assign(plugin.cache, result);

                debug('Generating result for webpack');

                var bundle_ = bundle + 'module.exports = ' + plugin.options.bundleNamespace + ';';

                fs.writeFile(plugin.options.bundleOutput, bundle_, function(error_){
                  invokeCallbacks(error_ || error, cache_);
                });
              });
            }
          });
        }
        else {
          debug('Skipped bundling of compiled PureScript files');

          invokeCallbacks(null, cache);
        }
      });
    }
  };
};

PurescriptWebpackPlugin.prototype.apply = function(compiler){
  var plugin = this;

  compiler.plugin('compilation', function(compilation, params){
    Object.assign(plugin.context, {
      requiresCompiling: true,
      bundleEntries: [],
      callbacks: [],
      compilation: null,
      compile: plugin.contextCompile.bind(plugin)
    });

    compilation.plugin('normal-module-loader', function(loaderContext, module){
      if (path.extname(module.userRequest) === PURS) {
        plugin.context.compilation = compilation;
        loaderContext.purescriptWebpackPluginContext = plugin.context;
      }
    });
  });

  compiler.plugin('normal-module-factory', function(normalModuleFactory){
    normalModuleFactory.plugin('after-resolve', function(data, callback){
      if (path.extname(data.userRequest) === PURS) {
        plugin.context.bundleEntries.push(data);
      }
      callback(null, data);
    });
  });
};

module.exports = PurescriptWebpackPlugin;
