import type { BrowserExtensionMainWorldBridge } from './browser-extension-main-world'

/** Main-only namespace behind connectNative/sendNativeMessage; never installed on `chrome`. */
export const PRELOAD_NATIVE_MESSAGING_NAMESPACE = 'orcaNativeMessaging'

export type BrowserExtensionNativeMessagingContext = 'page' | 'worker'

type ApiObject = Record<string, unknown>
type ExtensionCallable = (...args: unknown[]) => unknown

/**
 * Installs chrome.runtime.connectNative and sendNativeMessage for extensions that declare
 * "nativeMessaging". Main starts the host and routes its messages to this context only, by a port
 * id chosen here so events that beat the connect reply still find their port.
 *
 * Self-contained for the same reason as installBrowserExtensionApis: pages serialize it.
 */
export function installBrowserExtensionNativeMessaging(
  bridge: BrowserExtensionMainWorldBridge,
  context: BrowserExtensionNativeMessagingContext
): void {
  const namespace = 'orcaNativeMessaging'
  const portEvent = 'onPortEvent'
  const disconnectedError = 'Attempting to use a disconnected port object'
  const isObject = (value: unknown): value is ApiObject =>
    value !== null && typeof value === 'object'
  const isCallable = (value: unknown): value is ExtensionCallable => typeof value === 'function'
  const root: { chrome?: unknown; browser?: unknown } = globalThis
  const chromeApi = root.chrome
  const runtime = isObject(chromeApi) && isObject(chromeApi.runtime) ? chromeApi.runtime : null
  if (!runtime) {
    return
  }
  let manifest: unknown = null
  try {
    const getManifest = runtime.getManifest
    manifest = isCallable(getManifest) ? getManifest.call(runtime) : null
  } catch {
    manifest = null
  }
  // Why optional too: Chrome adds a granted API without a reload; main refuses calls until granted.
  const declared = isObject(manifest)
    ? [manifest.permissions, manifest.optional_permissions].flatMap((list) =>
        Array.isArray(list) ? list : []
      )
    : []
  if (!declared.includes('nativeMessaging')) {
    return
  }

  const callWithLastError = (message: string | null, callback: () => void): void => {
    let defined = false
    if (message !== null) {
      try {
        Object.defineProperty(runtime, 'lastError', {
          configurable: true,
          get: () => ({ message })
        })
        defined = true
      } catch {
        // Native lastError cannot be replaced here; the callback still runs.
      }
    }
    try {
      callback()
    } finally {
      if (defined) {
        try {
          delete runtime.lastError
        } catch {
          // ignore
        }
      }
    }
  }
  const serialize = (message: unknown): string => {
    const json: unknown = JSON.stringify(message)
    if (typeof json !== 'string') {
      throw new Error('Could not serialize message.')
    }
    return json
  }
  const makeEvent = () => {
    const listeners = new Set<ExtensionCallable>()
    return {
      listeners,
      api: {
        addListener: (callback: unknown) => {
          if (isCallable(callback)) {
            listeners.add(callback)
          }
        },
        removeListener: (callback: unknown) => {
          if (isCallable(callback)) {
            listeners.delete(callback)
          }
        },
        hasListener: (callback: unknown) => isCallable(callback) && listeners.has(callback),
        hasListeners: () => listeners.size > 0
      }
    }
  }
  const dispatch = (listeners: Set<ExtensionCallable>, args: unknown[]): void => {
    for (const listener of listeners) {
      try {
        listener(...args)
      } catch (error) {
        console.error(error)
      }
    }
  }

  type PortState = {
    // 'starting' until main confirms the host runs; posts wait for it.
    state: 'starting' | 'open' | 'closed'
    queued: string[]
    onMessage: Set<ExtensionCallable>
    onDisconnect: Set<ExtensionCallable>
    port: ApiObject
  }
  const ports = new Map<string, PortState>()
  let counter = 0

  const endPort = (id: string, entry: PortState, error: string | null): void => {
    entry.state = 'closed'
    ports.delete(id)
    if (error !== null && entry.onDisconnect.size === 0) {
      console.error(`Unchecked runtime.lastError: ${error}`)
    }
    callWithLastError(error, () => dispatch(entry.onDisconnect, [entry.port]))
  }

  bridge.onEvent((eventNamespace, event, args) => {
    if (eventNamespace !== namespace || event !== portEvent) {
      return
    }
    const [id, kind, data] = args
    const entry = typeof id === 'string' ? ports.get(id) : undefined
    if (!entry || typeof id !== 'string' || typeof data !== 'string') {
      return
    }
    if (kind === 'message') {
      let message: unknown
      try {
        message = JSON.parse(data)
      } catch {
        return
      }
      dispatch(entry.onMessage, [message, entry.port])
    } else if (kind === 'disconnect') {
      endPort(id, entry, data)
    }
  })

  const connectNative = (application: unknown): ApiObject => {
    if (typeof application !== 'string') {
      throw new TypeError(
        'Error in invocation of runtime.connectNative(string application): No matching signature.'
      )
    }
    // Why every connect: main refuses the listen until an optional permission is granted, and
    // a repeated listen is a no-op.
    if (context === 'worker') {
      bridge.listen(namespace, portEvent, true)
    }
    counter += 1
    const id = `${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2)}`
    const onMessage = makeEvent()
    const onDisconnect = makeEvent()
    const port: ApiObject = {}
    const entry: PortState = {
      state: 'starting',
      queued: [],
      onMessage: onMessage.listeners,
      onDisconnect: onDisconnect.listeners,
      port
    }
    Object.assign(port, {
      name: '',
      sender: undefined,
      onMessage: onMessage.api,
      onDisconnect: onDisconnect.api,
      postMessage: (message: unknown) => {
        if (entry.state === 'closed') {
          throw new Error(disconnectedError)
        }
        const json = serialize(message)
        if (entry.state === 'starting') {
          entry.queued.push(json)
        } else {
          void bridge.call(namespace, 'postMessage', [id, json])
        }
      },
      disconnect: () => {
        const wasOpen = entry.state === 'open'
        if (entry.state === 'closed') {
          return
        }
        entry.state = 'closed'
        ports.delete(id)
        if (wasOpen) {
          void bridge.call(namespace, 'disconnect', [id])
        }
      }
    })
    ports.set(id, entry)
    void bridge.call(namespace, 'connect', [id, application]).then((reply) => {
      if (!reply.ok) {
        if (entry.state !== 'closed') {
          endPort(id, entry, reply.error)
        }
        return
      }
      if (entry.state === 'closed') {
        // Disconnected (by the extension or the host) while starting: make sure main lets go.
        void bridge.call(namespace, 'disconnect', [id])
        return
      }
      entry.state = 'open'
      for (const json of entry.queued.splice(0)) {
        void bridge.call(namespace, 'postMessage', [id, json])
      }
    })
    return port
  }

  const sendNativeMessage = (application: unknown, message: unknown, callback?: unknown) => {
    const done = isCallable(callback) ? callback : null
    const run = async (): Promise<unknown> => {
      if (typeof application !== 'string') {
        throw new Error('Invalid native messaging host name specified.')
      }
      const reply = await bridge.call(namespace, 'sendNativeMessage', [
        application,
        serialize(message)
      ])
      if (!reply.ok) {
        throw new Error(reply.error)
      }
      return typeof reply.value === 'string' ? JSON.parse(reply.value) : undefined
    }
    const promise = run()
    if (!done) {
      return promise
    }
    promise.then(
      (value) => done(value),
      (error: unknown) =>
        callWithLastError(error instanceof Error ? error.message : String(error), () => done())
    )
    return undefined
  }

  const define = (target: ApiObject, key: string, value: unknown): void => {
    try {
      Object.defineProperty(target, key, {
        value,
        configurable: true,
        enumerable: true,
        writable: true
      })
    } catch {
      // Frozen native object: leave it.
    }
  }
  // Why `browser` too: it is a separate native global that WebExtension-style code reads first.
  const targets = [runtime]
  const browserRuntime = isObject(root.browser) ? root.browser.runtime : null
  if (isObject(browserRuntime) && browserRuntime !== runtime) {
    targets.push(browserRuntime)
  }
  for (const target of targets) {
    define(target, 'connectNative', connectNative)
    define(target, 'sendNativeMessage', sendNativeMessage)
  }
}
