import type {
  BrowserExtensionInvokeReply,
  BrowserExtensionMainWorldBridge
} from './browser-extension-main-world'
import type {
  BrowserExtensionStorageSyncForward,
  BrowserExtensionStorageSyncRelay
} from './browser-extension-storage-sync'

/**
 * Content scripts run in Chromium's per-extension isolated world, which no Orca preload reaches,
 * so their chrome.storage.sync is Electron's disabled one. Orca's content script sends those calls
 * as runtime messages to the extension's own worker, which makes them through main, and the worker
 * sends every sync change back to its tabs the same way. The messages carry this key; Orca hides
 * them from the extension's own onMessage listeners.
 */
export const CONTENT_SCRIPT_RELAY_KEY = 'orcaContentScriptRelay'

type ApiObject = Record<string, unknown>
type ExtensionCallable = (...args: unknown[]) => unknown

const isApiObject = (value: unknown): value is ApiObject =>
  value !== null && typeof value === 'object'

/**
 * Hides relayed messages from the extension's runtime.onMessage listeners; with `answer` (the
 * worker), also answers them. Pages pass no `answer`, so only the worker replies.
 *
 * Self-contained for the same reason as installBrowserExtensionApis: pages serialize it.
 */
export function installContentScriptRelayFilter(answer?: BrowserExtensionStorageSyncRelay): void {
  const key = 'orcaContentScriptRelay'
  const probeKey = 'orcaDocumentTargetProbe'
  const isObject = (value: unknown): value is ApiObject =>
    value !== null && typeof value === 'object'
  const isCallable = (value: unknown): value is ExtensionCallable => typeof value === 'function'
  const isRelayed = (message: unknown): boolean =>
    isObject(message) && (key in message || probeKey in message)
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
      const listener: ExtensionCallable = (message, ...rest) => {
        const probe = isObject(message) ? message[probeKey] : null
        const [sender, respond] = rest
        if (
          isObject(probe) &&
          typeof probe.token === 'string' &&
          probe.response !== true &&
          isObject(sender) &&
          sender.id === runtime.id &&
          wrapped.keys().next().value === callback &&
          isCallable(runtime.sendMessage) &&
          isCallable(respond)
        ) {
          Promise.resolve(
            runtime.sendMessage({
              [probeKey]: { token: probe.token, response: true }
            })
          ).then(
            () => respond(true),
            () => respond(false)
          )
          return true
        }
        return isRelayed(message) ? undefined : callback(message, ...rest)
      }
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
      const from = typeof request.from === 'string' ? request.from : undefined
      answer(request.method, request.args, from).then(
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

type NativeEvent = { addListener?: unknown; removeListener?: unknown }
type ContentScriptRuntime = { id?: unknown; onMessage?: unknown }

/**
 * The content script's way to main: a runtime message its worker answers. Sync changes come back
 * as messages from the worker; `from` names this frame's script so its own writes, which it
 * already delivered from the reply, are not delivered twice.
 */
export function createContentScriptRelayBridge(
  sendMessage: (message: unknown) => Promise<unknown>,
  runtime: ContentScriptRuntime
): BrowserExtensionMainWorldBridge {
  const isReply = (value: unknown): value is BrowserExtensionInvokeReply =>
    value !== null &&
    typeof value === 'object' &&
    'ok' in value &&
    (value.ok === true || ('error' in value && typeof value.error === 'string'))
  const from = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const extensionId = runtime.id
  // Why captured now: the relay filter later replaces onMessage with one that hides these messages.
  const onMessage: NativeEvent | null = isApiObject(runtime.onMessage) ? runtime.onMessage : null
  const handlers: ((namespace: string, event: string, args: unknown[]) => void)[] = []
  const receive = (message: unknown, sender: unknown): undefined => {
    const relayed = isApiObject(message) ? message[CONTENT_SCRIPT_RELAY_KEY] : null
    if (
      isApiObject(relayed) &&
      isApiObject(relayed.changes) &&
      relayed.from !== from &&
      isApiObject(sender) &&
      sender.id === extensionId
    ) {
      for (const handler of handlers) {
        handler('orcaStorageSync', 'onChanged', [relayed.changes])
      }
    }
    return undefined
  }
  return {
    call: async (_namespace, method, args) => {
      try {
        const reply = await sendMessage({ [CONTENT_SCRIPT_RELAY_KEY]: { method, args, from } })
        return isReply(reply) ? reply : { ok: false, error: 'Orca could not reach the extension' }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
    // Why only while listening: a native onMessage listener changes what tabs.sendMessage reports.
    listen: (_namespace, _event, active) => {
      const method = active ? onMessage?.addListener : onMessage?.removeListener
      if (typeof method === 'function') {
        method.call(onMessage, receive)
      }
    },
    onEvent: (handler) => {
      handlers.push(handler)
    },
    passesFilter: () => true
  }
}

/**
 * In the worker: sends each sync change to the extension's content scripts in every tab, except
 * the one that made it. Null when the extension has no manifest content scripts (the only ones
 * Orca's content script runs with).
 */
export function createContentScriptSyncForward(): BrowserExtensionStorageSyncForward | null {
  const root: { chrome?: unknown } = globalThis
  const chromeApi = isApiObject(root.chrome) ? root.chrome : null
  const tabs = chromeApi && isApiObject(chromeApi.tabs) ? chromeApi.tabs : null
  const runtime = chromeApi && isApiObject(chromeApi.runtime) ? chromeApi.runtime : null
  const query = tabs?.query
  const send = tabs?.sendMessage
  let manifest: unknown = null
  try {
    manifest = typeof runtime?.getManifest === 'function' ? runtime.getManifest() : null
  } catch {
    manifest = null
  }
  const contentScripts = isApiObject(manifest) ? manifest.content_scripts : null
  if (
    !tabs ||
    typeof query !== 'function' ||
    typeof send !== 'function' ||
    !Array.isArray(contentScripts) ||
    contentScripts.length === 0
  ) {
    return null
  }
  return (changes, from) => {
    const message = { [CONTENT_SCRIPT_RELAY_KEY]: { changes, from } }
    void Promise.resolve(query.call(tabs, {}))
      .then((list: unknown) => {
        for (const tab of Array.isArray(list) ? list : []) {
          if (isApiObject(tab) && typeof tab.id === 'number' && tab.discarded !== true) {
            // Why ignore failures: most tabs run none of the extension's content scripts.
            void Promise.resolve(send.call(tabs, tab.id, message)).catch(() => {})
          }
        }
      })
      .catch(() => {})
  }
}
