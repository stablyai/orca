/** `value` reaches the page callback; `error` becomes lastError around it. */
export type ChromeWebStoreBridgeReply = { value?: unknown; error?: string }

/** Isolated-world functions handed to the store page through contextBridge. */
export type ChromeWebStoreMainWorldBridge = {
  call: (method: string, args: unknown[]) => Promise<ChromeWebStoreBridgeReply>
  onEvent: (handler: (event: string, args: unknown[]) => void) => void
}

/**
 * Runs in the store page's main world via contextBridge.executeInMainWorld, which serializes the
 * function: it must not reference anything outside its own body (a test enforces this).
 *
 * Installs chrome.webstorePrivate and the chrome.management calls the store makes. Answers come
 * from main; lastError is set on chrome.runtime and chrome.extension only while a callback runs.
 * Shapes follow Chromium's webstore_private.json; approach informed by electron-chrome-web-store
 * (MIT, Samuel Maddock).
 */
export function installChromeWebStoreApis(
  bridge: ChromeWebStoreMainWorldBridge,
  chromeVersion: string
): void {
  type ApiObject = Record<string, unknown>
  type Callable = (...args: unknown[]) => unknown
  const isObject = (value: unknown): value is ApiObject =>
    value !== null && typeof value === 'object'
  const isCallable = (value: unknown): value is Callable => typeof value === 'function'
  const root: { chrome?: unknown } = globalThis
  const define = (target: ApiObject, key: string, value: unknown): void => {
    try {
      Object.defineProperty(target, key, {
        value,
        configurable: true,
        enumerable: true,
        writable: true
      })
    } catch {
      try {
        target[key] = value
      } catch {
        // Frozen object: leave it.
      }
    }
  }
  const ensureObject = (target: ApiObject, key: string): ApiObject => {
    const existing = target[key]
    if (isObject(existing)) {
      return existing
    }
    const created: ApiObject = {}
    define(target, key, created)
    return created
  }
  if (!isObject(root.chrome)) {
    define(root, 'chrome', {})
  }
  const chromeApi = isObject(root.chrome) ? root.chrome : {}
  const runtime = ensureObject(chromeApi, 'runtime')
  const extension = ensureObject(chromeApi, 'extension')

  const withLastError = (message: string | undefined, callback: () => void): void => {
    const targets = message === undefined ? [] : [runtime, extension]
    const defined: ApiObject[] = []
    for (const target of targets) {
      try {
        Object.defineProperty(target, 'lastError', {
          configurable: true,
          enumerable: true,
          get: () => ({ message })
        })
        defined.push(target)
      } catch {
        // A native lastError that cannot be replaced; the callback still runs.
      }
    }
    try {
      callback()
    } finally {
      for (const target of defined) {
        try {
          delete target.lastError
        } catch {
          // ignore
        }
      }
    }
  }

  /** Callback or promise, like Chrome: a trailing function is the callback. */
  const settle = (input: unknown[], reply: Promise<ChromeWebStoreBridgeReply>): unknown => {
    const last = input.at(-1)
    if (isCallable(last)) {
      void reply.then(
        (result) =>
          withLastError(result.error, () => {
            if (result.value === undefined) {
              last()
            } else {
              last(result.value)
            }
          }),
        () => withLastError('Orca could not handle this request', () => last())
      )
      return undefined
    }
    return reply.then((result) => {
      if (result.error !== undefined) {
        throw new Error(result.error)
      }
      return result.value
    })
  }
  const argsWithoutCallback = (input: unknown[]): unknown[] =>
    isCallable(input.at(-1)) ? input.slice(0, -1) : input
  const remote =
    (method: string) =>
    (...input: unknown[]): unknown =>
      settle(input, bridge.call(method, argsWithoutCallback(input)))
  const local =
    (value: unknown) =>
    (...input: unknown[]): unknown =>
      settle(input, Promise.resolve({ value }))

  const listeners = new Map<string, Set<Callable>>()
  const makeEvent = (name: string): ApiObject => {
    const set = new Set<Callable>()
    listeners.set(name, set)
    return {
      addListener: (listener: unknown) => {
        if (isCallable(listener)) {
          set.add(listener)
        }
      },
      removeListener: (listener: unknown) => {
        if (isCallable(listener)) {
          set.delete(listener)
        }
      },
      hasListener: (listener: unknown) => isCallable(listener) && set.has(listener),
      hasListeners: () => set.size > 0
    }
  }

  define(chromeApi, 'webstorePrivate', {
    Result: {
      EMPTY_STRING: '',
      SUCCESS: 'success',
      USER_CANCELLED: 'user_cancelled',
      INVALID_ID: 'invalid_id',
      MANIFEST_ERROR: 'manifest_error',
      ICON_ERROR: 'icon_error',
      INVALID_ICON_URL: 'invalid_icon_url',
      ALREADY_INSTALLED: 'already_installed',
      INSTALL_IN_PROGRESS: 'install_in_progress',
      INSTALL_ERROR: 'install_error',
      UNKNOWN_ERROR: 'unknown_error',
      UNSUPPORTED_EXTENSION_TYPE: 'unsupported_extension_type'
    },
    ExtensionInstallStatus: {
      INSTALLABLE: 'installable',
      ENABLED: 'enabled',
      DISABLED: 'disabled',
      BLOCKED_BY_POLICY: 'blocked_by_policy',
      DEPRECATED_MANIFEST_VERSION: 'deprecated_manifest_version'
    },
    MV2DeprecationStatus: {
      INACTIVE: 'inactive',
      WARNING: 'warning',
      SOFT_DISABLE: 'soft_disable',
      HARD_DISABLE: 'hard_disable'
    },
    WebGlStatus: { WEBGL_ALLOWED: 'webgl_allowed', WEBGL_BLOCKED: 'webgl_blocked' },
    beginInstallWithManifest3: remote('beginInstallWithManifest3'),
    completeInstall: remote('completeInstall'),
    getExtensionStatus: remote('getExtensionStatus'),
    isInIncognitoMode: local(false),
    getFullChromeVersion: local({ version_number: chromeVersion }),
    getBrowserLogin: local({ login: '' }),
    getStoreLogin: local(''),
    setStoreLogin: local(undefined),
    getReferrerChain: local(''),
    getMV2DeprecationStatus: local('hard_disable'),
    isPendingCustodianApproval: local(false),
    enableAppLauncher: local(undefined),
    getIsLauncherEnabled: local(false),
    getWebGLStatus: local('webgl_allowed')
  })

  const management = ensureObject(chromeApi, 'management')
  define(management, 'getAll', remote('management.getAll'))
  define(management, 'uninstall', remote('management.uninstall'))
  define(management, 'setEnabled', remote('management.setEnabled'))
  define(management, 'onInstalled', makeEvent('onInstalled'))
  define(management, 'onUninstalled', makeEvent('onUninstalled'))

  bridge.onEvent((event, args) => {
    for (const listener of listeners.get(event) ?? []) {
      try {
        listener(...args)
      } catch (error) {
        console.error(error)
      }
    }
  })
}
