// Why: Electron's browser guest diverges from Chrome on a few APIs that bot detectors read,
// and this script closes those specific gaps. It runs via Page.addScriptToEvaluateOnNewDocument
// before any page JS. Every override here has to earn its place against a measurement in
// anti-detection-automation-surface.electron.test.ts: what Electron already reports matches Chrome
// for navigator.webdriver, plugins and languages, so nothing masks those. Defining a property the
// engine keeps on a prototype moves it onto the instance, which is itself what detectors look for.
export const ANTI_DETECTION_SCRIPT = `(function() {
  // Why: auth hosts present Firefox, where Electron's native window.chrome is an identity mismatch.
  if (navigator.userAgent.includes('Firefox/')) {
    try {
      delete window.chrome;
      if ('chrome' in window) {
        window.chrome = undefined;
      }
    } catch {}
  } else {
    // Why: Electron webviews may not have the window.chrome object that real
    // Chrome exposes. Turnstile checks for its presence. The csi() and
    // loadTimes() stubs satisfy deeper probes of Chrome-specific APIs.
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.csi) {
      window.chrome.csi = function() {
        return {
          startE: Date.now(),
          onloadT: Date.now(),
          pageT: performance.now(),
          tran: 15
        };
      };
    }
    if (!window.chrome.loadTimes) {
      window.chrome.loadTimes = function() {
        return {
          commitLoadTime: Date.now() / 1000,
          connectionInfo: 'h2',
          finishDocumentLoadTime: Date.now() / 1000,
          finishLoadTime: Date.now() / 1000,
          firstPaintAfterLoadTime: 0,
          firstPaintTime: Date.now() / 1000,
          navigationType: 'Other',
          npnNegotiatedProtocol: 'h2',
          requestTime: Date.now() / 1000 - 0.16,
          startLoadTime: Date.now() / 1000 - 0.3,
          wasAlternateProtocolAvailable: false,
          wasFetchedViaSpdy: true,
          wasNpnNegotiated: true
        };
      };
    }
  }
  // Why: Electron's Permission API defaults to 'denied' for most permissions,
  // but real Chrome returns 'prompt' for ungranted permissions. Returning
  // 'denied' is a strong bot signal. Override the query result for common
  // permissions that Turnstile and similar detectors probe.
  var notificationPermission = 'default';
  var setNotificationPermission = function(permission) {
    if (permission === 'granted' || permission === 'denied') {
      notificationPermission = permission;
      return permission;
    }
    notificationPermission = 'default';
    return 'default';
  };
  var notificationPermissionState = function() {
    return notificationPermission === 'default' ? 'prompt' : notificationPermission;
  };
  try {
    if (Notification.permission === 'granted') {
      notificationPermission = 'granted';
    }
  } catch {}
  const promptPerms = new Set([
    'camera', 'microphone'
  ]);
  const origQuery = Permissions.prototype.query;
  // Why: sites must receive the genuine PermissionStatus so native events, brand checks and method
  // identity survive. Shadow only state, and resolve it lazily so existing statuses stay current.
  function withOverriddenState(realStatus, stateProvider) {
    Object.defineProperty(realStatus, 'state', {
      configurable: true,
      get: stateProvider
    });
    return realStatus;
  }
  // Why: some names the real implementation rejects outright; fall back to an EventTarget so
  // listener registration still works instead of throwing.
  function fallbackStatus(stateProvider) {
    const status = new EventTarget();
    Object.defineProperties(status, {
      state: { configurable: true, get: stateProvider },
      onchange: { configurable: true, value: null, writable: true }
    });
    return status;
  }
  function queryWithState(permissions, desc, stateProvider) {
    let real;
    try {
      real = origQuery.call(permissions, desc);
    } catch {
      return Promise.resolve(fallbackStatus(stateProvider));
    }
    return Promise.resolve(real).then(
      (status) => withOverriddenState(status, stateProvider),
      () => fallbackStatus(stateProvider)
    );
  }
  Permissions.prototype.query = function(desc) {
    if (desc.name === 'notifications') {
      return queryWithState(this, desc, notificationPermissionState);
    }
    if (promptPerms.has(desc.name)) {
      return queryWithState(this, desc, () => 'prompt');
    }
    return origQuery.call(this, desc);
  };
  // Why: Electron may report Notification.permission as 'denied' by default
  // whereas real Chrome reports 'default' for sites that haven't been granted
  // or blocked. Turnstile cross-references this with the Permissions API.
  try {
    Object.defineProperty(Notification, 'permission', {
      get: () => notificationPermission
    });
    const origRequestPermission = Notification.requestPermission;
    if (typeof origRequestPermission === 'function') {
      Notification.requestPermission = function(callback) {
        var wrappedCallback = typeof callback === 'function'
          ? function(permission) {
              callback(setNotificationPermission(permission));
            }
          : undefined;
        var result = origRequestPermission.call(Notification, wrappedCallback);
        if (result && typeof result.then === 'function') {
          return result.then(function(permission) {
            return setNotificationPermission(permission);
          });
        }
        return result;
      };
    }
  } catch {}
})()`
