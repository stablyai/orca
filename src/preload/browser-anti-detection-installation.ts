type BrowserChromeSurface = {
  csi?: () => Record<string, number>
  loadTimes?: () => Record<string, boolean | number | string>
}

type BrowserNotificationConstructor = typeof Notification & {
  permission: NotificationPermission
  requestPermission: (
    callback?: (permission: NotificationPermission) => void
  ) => Promise<NotificationPermission>
}

type BrowserPermissionsPrototype = {
  query: (descriptor: PermissionDescriptor) => Promise<PermissionStatus>
}

// Why: this copy keeps the sandboxed preload standalone; the parity test locks it to the CDP installer.
export function installBrowserAntiDetection(): void {
  // Why: this self-contained function runs both in the first-document preload and as a CDP source string.
  const webdriverDescriptor = Object.getOwnPropertyDescriptor(navigator, 'webdriver')
  try {
    if (webdriverDescriptor?.get?.call(navigator) === false) {
      return
    }
  } catch {}
  // Electron webviews expose an empty plugin list, unlike ordinary Chrome.
  if (navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', {
      configurable: true,
      get: () => [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' }
      ]
    })
  }

  const browserWindow = window as typeof window & { chrome?: BrowserChromeSurface }
  // Auth hosts present Firefox, where Electron's native window.chrome would contradict the UA.
  if (navigator.userAgent.includes('Firefox/')) {
    try {
      delete browserWindow.chrome
      if ('chrome' in browserWindow) {
        browserWindow.chrome = undefined
      }
    } catch {}
  } else {
    browserWindow.chrome ??= {}
    browserWindow.chrome.csi ??= function () {
      return {
        startE: Date.now(),
        onloadT: Date.now(),
        pageT: performance.now(),
        tran: 15
      }
    }
    browserWindow.chrome.loadTimes ??= function () {
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
      }
    }
  }

  // Keep Notification.permission and Permissions.query aligned with real prompt/grant state.
  let notificationPermission: NotificationPermission = 'default'
  const setNotificationPermission = (
    permission: NotificationPermission
  ): NotificationPermission => {
    if (permission === 'granted' || permission === 'denied') {
      notificationPermission = permission
      return permission
    }
    notificationPermission = 'default'
    return 'default'
  }
  const notificationPermissionState = (): PermissionState =>
    notificationPermission === 'default' ? 'prompt' : notificationPermission
  const browserNotification = Notification as BrowserNotificationConstructor
  try {
    if (browserNotification.permission === 'granted') {
      notificationPermission = 'granted'
    }
  } catch {}

  const promptPermissions = new Set<PermissionName>(['camera', 'microphone'])
  const permissionsPrototype = Object.getPrototypeOf(
    navigator.permissions
  ) as BrowserPermissionsPrototype
  const originalQuery = permissionsPrototype.query
  permissionsPrototype.query = function (descriptor: PermissionDescriptor) {
    if (descriptor.name === 'notifications') {
      return Promise.resolve({
        state: notificationPermissionState(),
        onchange: null
      } as PermissionStatus)
    }
    if (promptPermissions.has(descriptor.name)) {
      return Promise.resolve({ state: 'prompt', onchange: null } as PermissionStatus)
    }
    return originalQuery.call(this, descriptor)
  }

  try {
    Object.defineProperty(browserNotification, 'permission', {
      configurable: true,
      get: () => notificationPermission
    })
    const originalRequestPermission = browserNotification.requestPermission
    if (typeof originalRequestPermission === 'function') {
      browserNotification.requestPermission = function (callback) {
        const wrappedCallback =
          typeof callback === 'function'
            ? function (permission: NotificationPermission) {
                callback(setNotificationPermission(permission))
              }
            : undefined
        const result = originalRequestPermission.call(browserNotification, wrappedCallback)
        if (result && typeof result.then === 'function') {
          return result.then((permission) => setNotificationPermission(permission))
        }
        return result
      }
    }
  } catch {}

  if (!navigator.languages || navigator.languages.length === 0) {
    Object.defineProperty(navigator, 'languages', {
      configurable: true,
      get: () => ['en-US', 'en']
    })
  }
  Object.defineProperty(navigator, 'webdriver', {
    configurable: true,
    get: () => false
  })
}
