import type {
  BrowserExtensionInvokeReply,
  BrowserExtensionMainWorldBridge
} from './browser-extension-main-world'
import type { BrowserExtensionStorageSyncRelay } from './browser-extension-storage-sync'

/**
 * Content scripts run in Chromium's per-extension isolated world, which no Orca preload reaches,
 * so their chrome.storage.sync is Electron's disabled one. Orca's content script sends those calls
 * as runtime messages to the extension's own worker, which makes them through main. The message
 * carries this key; Orca hides such messages from the extension's own onMessage listeners.
 */
export const CONTENT_SCRIPT_RELAY_KEY = 'orcaContentScriptRelay'

type ApiObject = Record<string, unknown>
type ExtensionCallable = (...args: unknown[]) => unknown

/**
 * Hides relayed messages from the extension's runtime.onMessage listeners; with `answer` (the
 * worker), also answers them. Pages pass no `answer`, so only the worker replies.
 *
 * Self-contained for the same reason as installBrowserExtensionApis: pages serialize it.
 */
export function installContentScriptRelayFilter(answer?: BrowserExtensionStorageSyncRelay): void {
  const key = 'orcaContentScriptRelay'
  const isObject = (value: unknown): value is ApiObject =>
    value !== null && typeof value === 'object'
  const isCallable = (value: unknown): value is ExtensionCallable => typeof value === 'function'
  const isRelayed = (message: unknown): boolean => isObject(message) && key in message
  const root: { chrome?: unknown; browser?: unknown } = globalThis
  const chromeApi = root.chrome
  const runtime = isObject(chromeApi) ? chromeApi.runtime : null
  const native = isObject(runtime) ? runtime.onMessage : null
  if (!isObject(runtime) || !isObject(native) || !isCallable(native.addListener)) {
    return
  }
  const nativeEvent = native
  const call = (name: string, ...args: unknown[]): unknown => {
    const method = nativeEvent[name]
    return isCallable(method) ? method.apply(nativeEvent, args) : undefined
  }
  const wrapped = new Map<ExtensionCallable, ExtensionCallable>()
  const event: ApiObject = {
    addListener: (callback: unknown) => {
      if (!isCallable(callback) || wrapped.has(callback)) {
        return
      }
      const listener: ExtensionCallable = (message, ...rest) =>
        isRelayed(message) ? undefined : callback(message, ...rest)
      wrapped.set(callback, listener)
      call('addListener', listener)
    },
    removeListener: (callback: unknown) => {
      const listener = isCallable(callback) ? wrapped.get(callback) : undefined
      if (listener && isCallable(callback)) {
        wrapped.delete(callback)
        call('removeListener', listener)
      }
    },
    hasListener: (callback: unknown) => isCallable(callback) && wrapped.has(callback),
    hasListeners: () => wrapped.size > 0
  }
  if (answer) {
    const ownId = runtime.id
    call('addListener', (message: unknown, sender: unknown, sendResponse: unknown) => {
      const request = isObject(message) ? message[key] : null
      // Why sender.tab: only the extension's content scripts relay; its pages have their own area.
      if (
        !isObject(request) ||
        !isObject(sender) ||
        sender.id !== ownId ||
        !isObject(sender.tab) ||
        typeof request.method !== 'string' ||
        !Array.isArray(request.args) ||
        !isCallable(sendResponse)
      ) {
        return undefined
      }
      answer(request.method, request.args).then(
        (reply) => sendResponse(reply),
        () => sendResponse({ ok: false, error: 'Orca could not handle this extension call' })
      )
      return true
    })
  }
  const installed = new Set<object>()
  // Why `browser` too: it is a separate native global that WebExtension-style code reads first.
  for (const api of [chromeApi, root.browser]) {
    const target = isObject(api) ? api.runtime : null
    if (!isObject(target) || installed.has(target)) {
      continue
    }
    installed.add(target)
    try {
      Object.defineProperty(target, 'onMessage', {
        value: event,
        configurable: true,
        enumerable: true,
        writable: true
      })
    } catch {
      // Frozen native object: leave it.
    }
  }
}

/** The content script's way to main: a runtime message its worker answers. */
export function createContentScriptRelayBridge(
  sendMessage: (message: unknown) => Promise<unknown>
): BrowserExtensionMainWorldBridge {
  const isReply = (value: unknown): value is BrowserExtensionInvokeReply =>
    value !== null &&
    typeof value === 'object' &&
    'ok' in value &&
    (value.ok === true || ('error' in value && typeof value.error === 'string'))
  return {
    call: async (_namespace, method, args) => {
      try {
        const reply = await sendMessage({ [CONTENT_SCRIPT_RELAY_KEY]: { method, args } })
        return isReply(reply) ? reply : { ok: false, error: 'Orca could not reach the extension' }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    // Why no events: sync changes made elsewhere skip content scripts; their own writes still fire.
    listen: () => {},
    onEvent: () => {},
    passesFilter: () => true
  }
}
