import {
  BROWSER_EXTENSION_API_CALL_URL,
  BROWSER_EXTENSION_API_EVENTS_URL,
  BROWSER_EXTENSION_WORKER_TOKEN_FILE,
  decodeBrowserExtensionWireJson,
  encodeBrowserExtensionWireJson
} from '../shared/browser-extension-worker-api'
import { BROWSER_EXTENSION_API_SURFACE } from './browser-extension-api-surface'
import { installContentScriptRelayFilter } from './browser-extension-content-script-relay'
import { restorePersistedContentScripts } from './browser-extension-content-script-restore'
import {
  installBrowserExtensionDocumentTargets,
  PRELOAD_FIRST_DISCARDED_TAB_ID
} from './browser-extension-document-targets'
import { passesBrowserExtensionEventFilter } from './browser-extension-event-filters'
import { installBrowserExtensionInertApis } from './browser-extension-inert-apis'
import {
  installBrowserExtensionApis,
  type BrowserExtensionInvokeReply,
  type BrowserExtensionMainWorldBridge
} from './browser-extension-main-world'
import { installBrowserExtensionNativeMessaging } from './browser-extension-native-messaging'
import { installBrowserExtensionStorageRelay } from './browser-extension-storage-relay'
import {
  installBrowserExtensionStorageSync,
  PRELOAD_STORAGE_SYNC_CONSTANTS
} from './browser-extension-storage-sync'

/**
 * Orca's API shim for extension service workers, bundled into one standalone script that Orca's
 * background wrapper loads before the extension's own worker (importScripts or a side-effect
 * import). It installs the same `chrome.*` additions as the page preload, over fetch instead of IPC.
 */

const FAILED: BrowserExtensionInvokeReply = {
  ok: false,
  error: 'Orca could not handle this extension call'
}
const RECONNECT_DELAY_MS = 1000

// Why captured now: extension code that wraps fetch later must not see or break Orca's calls.
const nativeFetch = globalThis.fetch.bind(globalThis)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object'

function isReply(value: unknown): value is BrowserExtensionInvokeReply {
  return (
    isRecord(value) &&
    (value.ok === true || (value.ok === false && typeof value.error === 'string'))
  )
}

const tokenReady: Promise<string | null> = nativeFetch(`/${BROWSER_EXTENSION_WORKER_TOKEN_FILE}`, {
  cache: 'no-store'
})
  .then((response) => (response.ok ? response.json() : null))
  .then((value: unknown) =>
    isRecord(value) && typeof value.token === 'string' ? value.token : null
  )
  .catch(() => null)

// Why text/plain: a simple request skips the CORS preflight round trip.
function post(url: string, body: unknown): Promise<Response> {
  return nativeFetch(url, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'text/plain' },
    body: encodeBrowserExtensionWireJson(body)
  })
}

async function invoke(request: unknown): Promise<BrowserExtensionInvokeReply> {
  const token = await tokenReady
  if (!token) {
    return FAILED
  }
  try {
    const reply = decodeBrowserExtensionWireJson(
      await (await post(BROWSER_EXTENSION_API_CALL_URL, { token, request })).text()
    )
    return isReply(reply) ? reply : FAILED
  } catch {
    return FAILED
  }
}

const dispatchers: ((namespace: string, event: string, args: unknown[]) => void)[] = []

function deliver(line: string): void {
  let payload: unknown
  try {
    payload = decodeBrowserExtensionWireJson(line)
  } catch {
    return
  }
  if (
    isRecord(payload) &&
    typeof payload.namespace === 'string' &&
    typeof payload.event === 'string' &&
    Array.isArray(payload.args)
  ) {
    for (const dispatch of dispatchers) {
      dispatch(payload.namespace, payload.event, payload.args)
    }
  }
}

async function readLines(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) {
        return
      }
      buffered += decoder.decode(value, { stream: true })
      let newline = buffered.indexOf('\n')
      while (newline >= 0) {
        deliver(buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf('\n')
      }
    }
  } catch {
    // Stream broke; the caller reconnects.
  }
}

/** Last listen state per event, replayed after a reconnect so main flushes what it queued. */
const listening = new Map<string, { namespace: string; event: string; filters?: unknown[] }>()
// Why chained: add/remove must reach main in order, and only once the event stream is open
// (main flushes events queued for a stopped worker when the listener re-registers).
let markConnected: () => void = () => {}
let listenChain: Promise<unknown> = new Promise<void>((resolve) => {
  markConnected = resolve
})

function sendListen(namespace: string, event: string, active: boolean, filters?: unknown[]): void {
  listenChain = listenChain.then(() =>
    invoke({ type: 'listen', namespace, event, active, filters })
  )
}

async function connectEvents(): Promise<void> {
  const token = await tokenReady
  let connectedBefore = false
  while (token) {
    let response: Response | null = null
    try {
      response = await post(BROWSER_EXTENSION_API_EVENTS_URL, { token })
    } catch {
      response = null
    }
    if (response && !response.ok) {
      break
    }
    if (response?.body) {
      if (!connectedBefore) {
        connectedBefore = true
        markConnected()
      } else {
        for (const entry of listening.values()) {
          sendListen(entry.namespace, entry.event, true, entry.filters)
        }
      }
      await readLines(response.body)
    }
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS))
  }
  markConnected()
}

const bridge: BrowserExtensionMainWorldBridge = {
  call: (namespace, method, args) => invoke({ type: 'call', namespace, method, args }),
  listen: (namespace, event, active, filters) => {
    const key = `${namespace}.${event}`
    if (active) {
      listening.set(key, { namespace, event, filters })
    } else {
      listening.delete(key)
    }
    sendListen(namespace, event, active, filters)
  },
  onEvent: (handler) => {
    dispatchers.push(handler)
  },
  passesFilter: passesBrowserExtensionEventFilter
}

void connectEvents()
installBrowserExtensionApis(bridge, BROWSER_EXTENSION_API_SURFACE)
installBrowserExtensionStorageRelay(bridge, 'worker')
installBrowserExtensionNativeMessaging(bridge, 'worker')
installBrowserExtensionDocumentTargets(bridge, PRELOAD_FIRST_DISCARDED_TAB_ID)
installBrowserExtensionInertApis('worker')
installContentScriptRelayFilter(
  installBrowserExtensionStorageSync(bridge, PRELOAD_STORAGE_SYNC_CONSTANTS) ?? undefined
)
void restorePersistedContentScripts(invoke, globalThis)
