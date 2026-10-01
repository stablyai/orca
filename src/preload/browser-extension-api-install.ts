import type { BrowserExtensionNamespace } from './browser-extension-api-spec'

type Call = (namespace: string, method: string, args: unknown[]) => Promise<unknown>
type OnEvent = (dispatch: (key: string, args: unknown[]) => void) => void
type Listener = (...args: unknown[]) => unknown

/**
 * Runs in an extension's own world (its pages and service worker) and adds Orca's chrome.* APIs.
 * Why self-contained: Electron serializes this function into that world, so it can use nothing
 * from this module's scope; the bridge hands it `call` and `onEvent` as arguments.
 */
export function installBrowserExtensionApi(
  api: Record<string, BrowserExtensionNamespace>,
  privacySettings: Record<string, readonly string[]>,
  call: Call,
  onEvent: OnEvent
): void {
  const isListener = (value: unknown): value is Listener => typeof value === 'function'
  const chromeApi: Record<string, Record<string, unknown>> = Reflect.get(globalThis, 'chrome')
  const listeners = new Map<string, Set<Listener>>()
  onEvent((key, args) => {
    // A copy: a listener may remove itself while the event runs.
    for (const listener of Array.from(listeners.get(key) ?? [])) {
      try {
        listener(...args)
      } catch (error) {
        console.error(error)
      }
    }
  })
  const eventOf = (set: Set<Listener>, onFirst?: () => void) => ({
    addListener: (listener: Listener) => {
      if (set.size === 0) {
        onFirst?.()
      }
      set.add(listener)
    },
    removeListener: (listener: Listener) => void set.delete(listener),
    hasListener: (listener: Listener) => set.has(listener),
    hasListeners: () => set.size > 0
  })
  const makeEvent = (key: string) => {
    const set = listeners.get(key) ?? new Set<Listener>()
    listeners.set(key, set)
    // Main wakes this context for the event only once something listens.
    return eventOf(set, () => void call('events', 'listen', [key]))
  }
  // Chrome APIs take a trailing callback or return a promise.
  const settle = (result: Promise<unknown>, callback: unknown, label: string): unknown => {
    if (!isListener(callback)) {
      return result
    }
    result.then(
      (value) => callback(value),
      (error: unknown) => {
        console.error(`${label}:`, error)
        callback()
      }
    )
    return undefined
  }
  const invoke = (namespace: string, method: string, args: unknown[]): unknown => {
    const callback = args.at(-1)
    const rest = isListener(callback) ? args.slice(0, -1) : args
    return settle(call(namespace, method, rest), callback, `chrome.${namespace}.${method}`)
  }

  for (const [name, { methods, events, constants }] of Object.entries(api)) {
    const namespace = chromeApi[name] ?? (chromeApi[name] = {})
    Object.assign(namespace, constants)
    for (const method of methods) {
      namespace[method] = (...args: unknown[]) => invoke(name, method, args)
    }
    for (const event of events) {
      namespace[event] = makeEvent(`${name}.${event}`)
    }
  }

  // contextMenus.create returns the item id synchronously and may carry an onclick handler.
  const menuClicks = new Map<unknown, Listener>()
  makeEvent('contextMenus.onClicked').addListener((info, tab) =>
    menuClicks.get(Reflect.get(Object(info), 'menuItemId'))?.(info, tab)
  )
  chromeApi.contextMenus.create = (properties: Record<string, unknown>, callback?: unknown) => {
    const { onclick, ...rest } = properties
    const id = rest.id ?? `orca-${Date.now()}-${Math.random()}`
    if (isListener(onclick)) {
      menuClicks.set(id, onclick)
    }
    settle(call('contextMenus', 'create', [{ ...rest, id }]), callback, 'contextMenus.create')
    return id
  }

  // action.setIcon's ImageData cannot cross into main; send the largest as PNG bytes.
  chromeApi.action.setIcon = (details: Record<string, unknown>, callback?: unknown) => {
    const imageData: unknown = details.imageData
    if (!imageData) {
      return settle(call('action', 'setIcon', [details]), callback, 'action.setIcon')
    }
    const images: ImageData[] =
      imageData instanceof ImageData ? [imageData] : Object.values(Object(imageData))
    const largest = images.reduce((a, b) => (b.width > a.width ? b : a))
    const canvas = new OffscreenCanvas(largest.width, largest.height)
    canvas.getContext('2d')?.putImageData(largest, 0, 0)
    const sent = canvas
      .convertToBlob({ type: 'image/png' })
      .then((blob) => blob.arrayBuffer())
      .then((bytes) =>
        call('action', 'setIcon', [{ tabId: details.tabId, png: new Uint8Array(bytes) }])
      )
    return settle(sent, callback, 'action.setIcon')
  }

  // runtime.connectNative returns a Port at once; main relays the host's side by port id.
  type NativePort = { port: unknown; message: Set<Listener>; disconnect: Set<Listener> }
  const ports = new Map<unknown, NativePort>()
  // Why: the host can answer before the open call's reply names its port, so hold those events.
  const early = new Map<unknown, [unknown, unknown][]>()
  const deliver = (port: NativePort, id: unknown, kind: unknown, payload: unknown): void => {
    if (kind === 'message') {
      port.message.forEach((listener) => listener(payload, port.port))
    } else {
      ports.delete(id)
      port.disconnect.forEach((listener) => listener(port.port))
    }
  }
  makeEvent('runtime.nativePort').addListener((id, kind, payload) => {
    const port = ports.get(id)
    if (port) {
      deliver(port, id, kind, payload)
    } else {
      early.set(id, [...(early.get(id) ?? []), [kind, payload]])
    }
  })
  chromeApi.runtime.connectNative = (application: string) => {
    const handlers = { message: new Set<Listener>(), disconnect: new Set<Listener>() }
    const opened = call('nativePort', 'open', [application])
    const port = {
      name: application,
      onMessage: eventOf(handlers.message),
      onDisconnect: eventOf(handlers.disconnect),
      postMessage: (message: unknown) =>
        void opened.then((id) => call('nativePort', 'post', [id, message])),
      disconnect: () =>
        void opened.then((id) => {
          ports.delete(id)
          return call('nativePort', 'disconnect', [id])
        })
    }
    const entry = { port, ...handlers }
    opened.then(
      (id) => {
        ports.set(id, entry)
        for (const [kind, payload] of early.get(id) ?? []) {
          deliver(entry, id, kind, payload)
        }
        early.delete(id)
      },
      () => handlers.disconnect.forEach((listener) => listener(port))
    )
    return port
  }

  // chrome.privacy: ChromeSetting objects whose values main keeps per extension.
  const privacy: Record<string, Record<string, unknown>> = {}
  for (const [group, names] of Object.entries(privacySettings)) {
    privacy[group] = {}
    for (const name of names) {
      const path = `${group}.${name}`
      privacy[group][name] = {
        get: (_details: unknown, callback?: unknown) =>
          settle(call('privacy', 'get', [path]), callback, 'privacy.get'),
        set: (details: unknown, callback?: unknown) =>
          settle(call('privacy', 'set', [path, details]), callback, 'privacy.set'),
        clear: (_details: unknown, callback?: unknown) =>
          settle(call('privacy', 'clear', [path]), callback, 'privacy.clear'),
        onChange: makeEvent(`privacy.${path}`)
      }
    }
  }
  chromeApi.privacy = privacy

  // Electron's own `browser` namespace lacks everything above; extensions like 1Password use it.
  Reflect.set(globalThis, 'browser', chromeApi)
}
