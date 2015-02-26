/*!
  backbone.fetch-cache v1.4.1
  by Andy Appleton - https://github.com/mrappleton/backbone-fetch-cache.git
 */

// AMD wrapper from https://github.com/umdjs/umd/blob/master/amdWebGlobal.js

(function(root, factory) {
  if (typeof define === 'function' && define.amd) {
    // AMD. Register as an anonymous module and set browser global
    define(['underscore', 'backbone', 'jquery'], function(_, Backbone, $) {
      return (root.Backbone = factory(_, Backbone, $));
    });
  } else if (typeof exports !== 'undefined' && typeof require !== 'undefined') {
    module.exports = factory(require('underscore'), require('backbone'), require('jquery'));
  } else {
    // Browser globals
    root.Backbone = factory(root._, root.Backbone, root.jQuery);
  }
}(this, function(_, Backbone, $) {

  // Setup
  var superMethods = {
      modelFetch: Backbone.Model.prototype.fetch,
      modelSync: Backbone.Model.prototype.sync,
      collectionFetch: Backbone.Collection.prototype.fetch
    },
    supportLocalStorage = (function() {
      var supported = typeof window.localStorage !== 'undefined';
      if (supported) {
        try {
          // impossible to write on some platforms when private browsing is on and
          // throws an exception = local storage not supported.
          localStorage.setItem('test_support', 'test_support');
          localStorage.removeItem('test_support');
        } catch (e) {
          supported = false;
        }
      }
      return supported;
    })(),
    localStorageContent = {},
    supportIndexDB = !!window.indexedDB;

  Backbone.fetchCache = (Backbone.fetchCache || {});
  Backbone.fetchCache._cache = (Backbone.fetchCache._cache || {});
  // Global flag to enable/disable caching
  Backbone.fetchCache.enabled = true;
  Backbone.fetchCache.selfParameter = true;
  Backbone.fetchCache.prefetch = false;

  Backbone.fetchCache.useIndexDB = false;
  Backbone.fetchCache._prerequests = {};

  Backbone.fetchCache.enablePrefetch = function() {
    Backbone.fetchCache.prefetch = true;
    Backbone.fetchCache.getPrefetchRequests();
  };

  Backbone.fetchCache.disablePrefetch = function() {
    Backbone.fetchCache.prefetch = false;
  };

  Backbone.fetchCache.priorityFn = function(a, b) {
    if (!a || !a.expires || !b || !b.expires) {
      return a;
    }

    return a.expires - b.expires;
  };

  Backbone.fetchCache._prioritize = function(data) {
    var sorted = _.values(data).sort(this.priorityFn);
    var index = _.indexOf(_.values(data), sorted[0]);
    return _.keys(data)[index];
  };
  // process request before storing it for prefetching
  Backbone.fetchCache.prefetchStoreProcessor = function(element) {
    return element;
  };

  // process request on retrieval for prefetching 
  Backbone.fetchCache.prefetchRetrieveProcessor = function(element) {
    return element;
  };


  Backbone.fetchCache._deleteCacheWithPriority = function(data) {
    var key = this._prioritize(data);
    data[key] = null;
    delete data[key];
    Backbone.fetchCache.setLocalStorage(data);
  };

  Backbone.fetchCache.getLocalStorageKey = function() {
    return 'backboneCache';
  };

  Backbone.fetchCache.getPrefetchStorageKey = function() {
    return 'backboneCachePrefetch';
  };

  if (typeof Backbone.fetchCache.localStorage === 'undefined') {
    Backbone.fetchCache.localStorage = true;
  }

  // Shared methods
  function getCacheKey(key, opts) {
    if (key && _.isObject(key)) {
      // If the model has its own, custom, cache key function, use it.
      if (_.isFunction(key.getCacheKey)) {
        return key.getCacheKey(opts);
      }
      // else, use the URL
      if (opts && opts.url) {
        key = opts.url;
      } else {
        key = _.isFunction(key.url) ? key.url() : key.url;
      }
    } else if (_.isFunction(key)) {
      return key(opts);
    }
    if (opts && opts.data) {
      if (typeof opts.data === 'string') {
        return key + '?' + opts.data;
      } else {
        return key + '?' + $.param(opts.data);
      }
    }
    return key;
  }

  function setCache(instance, opts, attrs) {
    opts = (opts || {});
    var key = Backbone.fetchCache.getCacheKey(instance, opts),
      expires = false,
      onExpire = null,
      lastSync = (opts.lastSync || (new Date()).getTime()),
      prefillExpires = false,
      onPrefillExpire = null,
      dataToSave;

    // Need url to use as cache key so return if we can't get it
    if (!key) {
      return;
    }

    // Never set the cache if user has explicitly said not to
    if (opts.cache === false) {
      return;
    }

    // Don't set the cache unless cache: true or prefill: true option is passed
    if (!(opts.cache || opts.prefill)) {
      return;
    }

    if (opts.expires !== false) {
      expires = (new Date()).getTime() + ((opts.expires || 5 * 60) * 1000);
      onExpire = (function() {
        setTimeout(function() {
          instance.trigger('cacheexpired', instance, attrs, opts);
        }, (opts.expires || 5 * 60) * 1000);
      }());
    }

    if (opts.prefillExpires !== false) {
      prefillExpires = (new Date()).getTime() + ((opts.prefillExpires || 5 * 60) * 1000);
      onPrefillExpire = (function() {
        setTimeout(function() {
          instance.trigger('cacheprefillexpired', instance, attrs, opts);
        }, (opts.prefillExpires || 5 * 60) * 1000);
      }());
    }

    dataToSave = {
      expires: expires,
      onExpire: onExpire,
      lastSync: lastSync,
      prefillExpires: prefillExpires,
      onPrefillExpire: onPrefillExpire,
      value: attrs
    };

    Backbone.fetchCache._cache[key] = dataToSave;
    localStorageContent[key] = dataToSave;

    Backbone.fetchCache.setLocalStorage(localStorageContent);
    if (Backbone.fetchCache.prefetch) {
      saveToPrefetch(instance, opts);
    }
  }

  function saveToPrefetch(instance, opts) {
    var data = {
        type: instance instanceof Backbone.Model ? 'Model' : 'Collection',
        saveTime: (new Date()).getTime(),
        opts: _.extend({}, instance.url && !opts.url ? {
          url: _.isFunction(instance.url) ? instance.url() : instance.url
        } : {}, opts)
      },
      key = Backbone.fetchCache.getCacheKey(instance, opts);

    delete data.opts.beforeSend;
    delete data.opts.success;
    delete data.opts.fail;
    delete data.opts.error;
    Backbone.fetchCache._prerequests[key] = Backbone.fetchCache.prefetchStoreProcessor(data);
    Backbone.fetchCache.setPrefetchRequests();
  }

  function getCache(key, opts) {
    if (_.isFunction(key)) {
      key = key();
    } else if (key && _.isObject(key)) {
      key = getCacheKey(key, opts);
    }

    return Backbone.fetchCache._cache[key];
  }

  function getLastSync(key, opts) {
    return getCache(key) && getCache(key).lastSync;
  }

  function clearItem(key, opts) {
    if (_.isFunction(key)) {
      key = key();
    } else if (key && _.isObject(key)) {
      key = getCacheKey(key, opts);
    }
    delete Backbone.fetchCache._cache[key];
    if (localStorageContent[key]) {
      delete localStorageContent[key];
      Backbone.fetchCache.setLocalStorage(localStorageContent);
    }
  }

  function setLocalStorage(data) {
    if (!supportLocalStorage || !Backbone.fetchCache.localStorage) {
      return;
    }
    try {
      localStorage.setItem(Backbone.fetchCache.getLocalStorageKey(), JSON.stringify(data));
    } catch (err) {
      var code = err.code || err.number || err.message;
      if (code === 22 || code === 1014) {
        this._deleteCacheWithPriority(data);
      } else {
        throw (err);
      }
    }
  }

  function _indexDBHelper() {
    var request,
      db,
      promise = $.Deferred();
    if (!supportIndexDB || !Backbone.fetchCache.useIndexDB) {
      promise.reject('not supported');
    }

    function setDB(event) {
      var db = event.target.result;
      promise.resolve(db);
    }

    try {
      request = window.indexedDB.open('fetchCache', 1);
      request.onsuccess = function(event) {
        db = setDB(event);
      };
      request.onfailure = function(event) {
        promise.reject('failed with error code: ' + request.errorCode);
      };
      request.onupgradeneeded = function(event) {
        var db = event.target.result,
          objectStore;
        objectStore = db.createObjectStore('fetchCacheHistory');
        objectStore.transaction.oncomplete = function(event) {
          promise.resolve(db);
        };
      };
    } catch (e) {
      promise.reject(e.message);
    }
    return promise;
  }

  function saveToIndexedDB(success, failure) {
    var promise = _indexDBHelper(),
      setValuesToDB = function(db) {
        var transaction = db.transaction(['fetchCacheHistory'], 'readwrite'),
          objectStore = transaction.objectStore('fetchCacheHistory'),
          req;
        transaction.oncomplete = success;
        // first lets clear what's inside the store
        req = objectStore.clear();
        req.onsuccess = function() {
          try {
            objectStore.add({
              history: _.clone(Backbone.fetchCache._prerequests)
            }, Backbone.fetchCache.getPrefetchStorageKey());
          } catch (e) {

          }

        };
      };
    promise.done(function(db) {
      db.onerror = function(event) {
        failure('failed with error code: ' + event.target.errorCode);
      };
      setValuesToDB(db);
    });
    promise.fail(function(arg) {
      failure(arg);
    });
  }

  function loadFromIndexedDB(success, failure) {
    var promise = _indexDBHelper(),
      getValueFromDB = function(db) {
        var transaction = db.transaction(['fetchCacheHistory'], 'readwrite'),
          objectStore = transaction.objectStore('fetchCacheHistory'),
          prefetchObject = {};
        objectStore.openCursor().onsuccess = function(event) {
          var cursor = event.target.result;
          if (cursor) {
            prefetchObject = cursor.value.history;
            cursor['continue']();
          } else {
            success(prefetchObject);
          }
        };
      };
    promise.done(function(db) {
      db.onerror = function(event) {
        promise.reject('failed with error code: ' + event.target.errorCode);
      };
      getValueFromDB(db);
    });
    promise.fail(function(arg) {
      failure(arg);
    });
  }

  function setPrefetchRequests() {
    var indexFailFn = function() {
      if (!Backbone.fetchCache.localStorage) {
        return;
      }
      supportIndexDB = false;
      try {
        localStorage.setItem(Backbone.fetchCache.getPrefetchStorageKey(), JSON.stringify(Backbone.fetchCache._prerequests));
      } catch (err) {
        var code = err.code || err.number || err.message;
        if (code === 22 || code === 1014) {
          // for now just deleting request data if it gets full
          this._deleteCacheWithPriority();
          Backbone.fetchCache.setPrefetchRequests();
        } else {
          throw (err);
        }
      }
    };
    if (!supportLocalStorage || !Backbone.fetchCache.prefetch) {
      return;
    }

    if (supportIndexDB && Backbone.fetchCache.useIndexDB) {
      if (!Backbone.fetchCache.indexSaveBlocked) { // already active don't send another write
        saveToIndexedDB(function() {
          Backbone.fetchCache.indexSaveBlocked = false;
        }, indexFailFn);
      }
    } else {
      indexFailFn();
    }
  }

  function getLocalStorage() {
    var parsedJSON = {};
    if (!supportLocalStorage || !Backbone.fetchCache.localStorage) {
      return;
    }
    var json = localStorage.getItem(Backbone.fetchCache.getLocalStorageKey()) || '{}';
    parsedJSON = JSON.parse(json);
    Backbone.fetchCache._cache = parsedJSON;
    localStorageContent = parsedJSON;
  }

  // calling fetch helper insures that we won't flood the request buffer
  var fetchHelper = (function(argument) {
    var currentRequests = [];

    function startFetchingRequests() {
      if (currentRequests.length > 0) {
        if ($.active < 2) {
          currentRequests.splice(0, 1)[0]();
          startFetchingRequests();
        } else {
          setTimeout(startFetchingRequests, 2000);
        }
      }
    }
    return function(fn) {
      currentRequests.push(fn);
      startFetchingRequests();
    };
  })();

  function _prefetchInitializer(requests) {
    _.each(requests, function(element, key) {
      var processedElement = Backbone.fetchCache.prefetchRetrieveProcessor(element);
      Backbone.fetchCache._prerequests[key] = processedElement;
      fetchHelper(function() {
        var possibleResult = getCache(key);
        if (!possibleResult || !possibleResult.data || possibleResult.data.expires > (new Date()).getTime()) {
          (new Backbone[processedElement.type]()).fetch(element.opts);
        }
      });
    });

    Backbone.fetchCache._prerequests = {};
  }

  function getPrefetchRequests() {
    var json,
      indexFailFn = function() { // try local storage if index fails
        if (!Backbone.fetchCache.localStorage) {
          return;
        }
        json = localStorage.getItem(Backbone.fetchCache.getPrefetchStorageKey());
        _prefetchInitializer(JSON.parse(json));
      };
    if (!supportLocalStorage || !Backbone.fetchCache.prefetch) {
      return;
    }

    if (supportIndexDB && Backbone.fetchCache.useIndexDB) {
      loadFromIndexedDB(function(requests) {
        _prefetchInitializer(requests);
      }, indexFailFn);
    } else {
      indexFailFn();
    }
  }

  function nextTick(fn) {
    return window.setTimeout(fn, 0);
  }

  // Instance methods
  Backbone.Model.prototype.fetch = function(opts) {
    //Bypass caching if it's not enabled
    if (!Backbone.fetchCache.enabled) {
      return superMethods.modelFetch.apply(this, arguments);
    }
    opts = _.defaults(opts || {}, {
      parse: true
    });
    var key = Backbone.fetchCache.getCacheKey(this, opts),
      data = getCache(key),
      expired = false,
      prefillExpired = false,
      attributes = false,
      deferred = new $.Deferred(),
      self = this;
    deferred.success = deferred.done;
    deferred.error = deferred.fail;

    function isPrefilling() {
      return opts.prefill && (!opts.prefillExpires || prefillExpired);
    }

    function setData() {
      var resolveValues = (Backbone.fetchCache.selfParameter ? [] : [data.value]).concat(self);
      if (opts.parse) {
        attributes = self.parse(attributes, opts);
      }

      self.set(attributes, opts);
      if (_.isFunction(opts.prefillSuccess)) {
        opts.prefillSuccess(self, attributes, opts);
      }

      // Trigger sync events
      self.trigger('cachesync', self, attributes, opts);
      self.trigger('sync', self, attributes, opts);

      // Notify progress if we're still waiting for an AJAX call to happen...
      if (isPrefilling()) {
        deferred.notify.apply(self, resolveValues);
      }
      // ...finish and return if we're not
      else {
        if (_.isFunction(opts.success)) {
          opts.success(self, attributes, opts);
        }
        deferred.resolve.apply(self, resolveValues);
      }
    }

    if (data) {
      expired = data.expires;
      expired = expired && data.expires <= (new Date()).getTime();
      prefillExpired = data.prefillExpires;
      prefillExpired = prefillExpired && data.prefillExpires <= (new Date()).getTime();
      attributes = data.value;
    }

    if (!expired && (opts.cache || opts.prefill) && attributes) {
      // Ensure that cache resolution adhers to async option, defaults to true.
      if (opts.async == null) {
        opts.async = true;
      }

      // Execute beforeSend
      if (opts.beforeSend) {
        opts.beforeSend.apply(this, [deferred, opts]); // normally is jqXHR, this, but we don't store the jqXHR so sending data instead
      }
      if (opts.async) {
        nextTick(setData);
      } else {
        setData();
      }

      if (!isPrefilling()) {
        return deferred;
      }
    }

    // Delegate to the actual fetch method and store the attributes in the cache
    var jqXHR = superMethods.modelFetch.apply(this, arguments),
      resolveArgs = [];
    if (Backbone.fetchCache.selfParameter) {
      resolveArgs.push(this);
    }

    // resolve the returned promise when the AJAX call completes
    jqXHR.done(function(data) {
      deferred.resolve.apply(self, resolveArgs.concat([data, self]));
    })
    // Set the new data in the cache
    .done(_.bind(Backbone.fetchCache.setCache, null, this, opts))
    // Reject the promise on fail
    .fail(_.bind.apply(_, [deferred.reject].concat(resolveArgs)));

    deferred.abort = jqXHR.abort;

    // return a promise which provides the same methods as a jqXHR object
    return deferred;
  };

  // Override Model.prototype.sync and try to clear cache items if it looks
  // like they are being updated.
  Backbone.Model.prototype.sync = function(method, model, options) {
    // Only empty the cache if we're doing a create, update, patch or delete.
    // or caching is not enabled
    if (method === 'read' || !Backbone.fetchCache.enabled) {
      return superMethods.modelSync.apply(this, arguments);
    }

    var collection = model.collection,
      keys = [],
      i, len;

    // Build up a list of keys to delete from the cache, starting with this
    keys.push(Backbone.fetchCache.getCacheKey(model, options));

    // If this model has a collection, also try to delete the cache for that
    if (!!collection) {
      keys.push(Backbone.fetchCache.getCacheKey(collection));
    }

    // Empty cache for all found keys
    for (i = 0, len = keys.length; i < len; i++) {
      clearItem(keys[i]);
    }

    return superMethods.modelSync.apply(this, arguments);
  };

  Backbone.Collection.prototype.fetch = function(opts) {
    // Bypass caching if it's not enabled
    if (!Backbone.fetchCache.enabled) {
      return superMethods.collectionFetch.apply(this, arguments);
    }

    opts = _.defaults(opts || {}, {
      parse: true
    });
    var self = this,
      expired = false,
      prefillExpired = false,
      attributes = false,
      deferred = new $.Deferred(),
      key = Backbone.fetchCache.getCacheKey(self, opts),
      data = getCache(key);

    deferred.success = deferred.done;
    deferred.error = deferred.fail;



    function isPrefilling() {
      return opts.prefill && (!opts.prefillExpires || prefillExpired);
    }

    function setData() {
      var resolveValues = (Backbone.fetchCache.selfParameter ? [] : [data.value]).concat(self);
      self[opts.reset ? 'reset' : 'set'](attributes, opts);
      if (_.isFunction(opts.prefillSuccess)) {
        opts.prefillSuccess(self);
      }

      // Trigger sync events
      self.trigger('cachesync', self, attributes, opts);
      self.trigger('sync', self, attributes, opts);

      // Notify progress if we're still waiting for an AJAX call to happen...
      if (isPrefilling()) {
        deferred.notify.apply(self, resolveValues);
      }
      // ...finish and return if we're not
      else {
        if (_.isFunction(opts.success)) {
          opts.success(self, attributes, opts);
        }
        deferred.resolve.apply(self, resolveValues);
      }
    }

    if (data) {
      expired = data.expires;
      expired = expired && data.expires <= (new Date()).getTime();
      prefillExpired = data.prefillExpires;
      prefillExpired = prefillExpired && data.prefillExpires <= (new Date()).getTime();
      attributes = data.value;
    }

    if (!expired && (opts.cache || opts.prefill) && attributes) {
      // Ensure that cache resolution adhers to async option, defaults to true.
      if (opts.async == null) {
        opts.async = true;
      }

      // Execute beforeSend
      if (opts.beforeSend) {
        opts.beforeSend.apply(this, [deferred, opts]); // normally is jqXHR, this, but we don't store the jqXHR so sending data instead
      }

      if (opts.async) {
        nextTick(setData);
      } else {
        setData();
      }

      if (!isPrefilling()) {
        return deferred;
      }
    }

    // Delegate to the actual fetch method and store the attributes in the cache
    var jqXHR = superMethods.collectionFetch.apply(this, arguments),
      resolveArgs = [];
    if (Backbone.fetchCache.selfParameter) {
      resolveArgs.push(this);
    }

    // resolve the returned promise when the AJAX call completes
    jqXHR.done(function(data) {
      deferred.resolve.apply(self, resolveArgs.concat([data, self]));
    })
    // Set the new data in the cache
    .done(_.bind(Backbone.fetchCache.setCache, null, this, opts))
    // Reject the promise on fail
    .fail(_.bind.apply(_, [deferred.reject].concat(resolveArgs)));

    deferred.abort = jqXHR.abort;
    // return a promise which provides the same methods as a jqXHR object
    return deferred;
  };

  // Prime the cache from localStorage on initialization
  getLocalStorage();

  // Start Prefetching
  getPrefetchRequests();

  // Exports

  Backbone.fetchCache._superMethods = superMethods;
  Backbone.fetchCache.setCache = setCache;
  Backbone.fetchCache.getCache = getCache;
  Backbone.fetchCache.getCacheKey = getCacheKey;
  Backbone.fetchCache.getLastSync = getLastSync;
  Backbone.fetchCache.clearItem = clearItem;
  Backbone.fetchCache.setLocalStorage = setLocalStorage;
  Backbone.fetchCache.getLocalStorage = getLocalStorage;
  Backbone.fetchCache.setPrefetchRequests = setPrefetchRequests;
  Backbone.fetchCache.getPrefetchRequests = getPrefetchRequests;

  return Backbone;
}));