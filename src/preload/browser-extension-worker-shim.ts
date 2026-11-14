import { installBrowserExtensionMessageTargets } from './browser/extensions/documents/browser-extension-message-targets'
import {
  BROWSER_EXTENSION_API_CALL_URL,
  BROWSER_EXTENSION_API_EVENTS_URL,
  BROWSER_EXTENSION_WORKER_TOKEN_FILE,
  decodeBrowserExtensionWireJson,
  encodeBrowserExtensionWireJson
} from '../shared/browser/extensions/browser-extension-worker-api'
import { BROWSER_EXTENSION_API_SURFACE } from './browser/extensions/api/browser-extension-api-surface'
import {
  createContentScriptSyncForward,
  installContentScriptRelayFilter
} from './browser/extensions/messaging/browser-extension-content-script-relay'
import {
  installBrowserExtensionDocumentTargets,
  PRELOAD_FIRST_DISCARDED_TAB_ID
} from './browser/extensions/documents/browser-extension-document-targets'
import { passesBrowserExtensionEventFilter } from './browser/extensions/api/browser-extension-event-filters'
import { installBrowserExtensionInertApis } from './browser/extensions/api/browser-extension-inert-apis'
import {
  installBrowserExtensionApis,
  type BrowserExtensionInvokeReply,
  type BrowserExtensionMainWorldBridge
} from './browser/extensions/api/browser-extension-main-world'
import { installBrowserExtensionNativeMessaging } from './browser/extensions/messaging/browser-extension-native-messaging'
import { installBrowserExtensionStorageRelay } from './browser/extensions/storage/browser-extension-storage-relay'
import {
  installBrowserExtensionStorageSync,
  PRELOAD_STORAGE_SYNC_CONSTANTS
} from './browser/extensions/storage/browser-extension-storage-sync'

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
let evaluated = (): void => {}
const evaluationComplete = new Promise<void>((resolve) => {
  evaluated = resolve
})
Object.defineProperty(globalThis, '__orcaExtensionWorkerEvaluated', { value: () => evaluated() })

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

type NativeWorkerChrome = {
  runtime?: {
    id?: string
    onMessage?: { addListener: (listener: (...args: unknown[]) => unknown) => void }
  }
}
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Electron provides chrome.runtime in the extension worker global.
const nativeChrome = (globalThis as { chrome?: NativeWorkerChrome }).chrome
const nativeRuntime = nativeChrome?.runtime
nativeRuntime?.onMessage?.addListener((message, sender, respond) => {
  const challenge = isRecord(message) ? message.orcaExecutionActivation : null
  if (
    typeof challenge !== 'string' ||
    !isRecord(sender) ||
    sender.id !== nativeRuntime.id ||
    sender.url !== `chrome-extension://${nativeRuntime.id}/manifest.json?orca-native-page=1` ||
    typeof respond !== 'function'
  ) {
    return undefined
  }
  void (async () => {
    const token = await tokenReady
    const current = connection ?? (await nextConnection)
    await current.ready
    await current.chain
    respond({
      challenge,
      token: connection === current && !current.controller.signal.aborted ? token : null,
      connectionId: current.id
    })
  })().catch(() => {
    try {
      respond({ challenge, token: null })
    } catch {
      // The native sender may already have gone.
    }
  })
  return true
})

// Why text/plain: a simple request skips the CORS preflight round trip.
function post(url: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  return nativeFetch(url, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'text/plain' },
    body: encodeBrowserExtensionWireJson(body),
    signal
  })
}

async function invoke(request: unknown): Promise<BrowserExtensionInvokeReply> {
  const token = await tokenReady
  if (!token) {
    return FAILED
  }
  try {
    const reply = decodeBrowserExtensionWireJson(
      await (
        await post(BROWSER_EXTENSION_API_CALL_URL, { token, request, connectionId: connection?.id })
      ).text()
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
    if (typeof payload.deliveryId === 'string') {
      void invoke({ type: 'receipt', deliveryId: payload.deliveryId })
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
type WorkerConnection = {
  id: string
  controller: AbortController
  chain: Promise<void>
  ready: Promise<void>
}
let connection: WorkerConnection | null = null
let openedConnection = (_connection: WorkerConnection): void => {}
let nextConnection = new Promise<WorkerConnection>((resolve) => {
  openedConnection = resolve
})

async function publish(current: WorkerConnection, request: unknown): Promise<void> {
  const token = await tokenReady
  if (!token || connection !== current || current.controller.signal.aborted) {
    throw new Error('Extension worker connection was closed')
  }
  const response = await post(
    BROWSER_EXTENSION_API_CALL_URL,
    { token, connectionId: current.id, request },
    current.controller.signal
  )
  const reply = response.ok ? decodeBrowserExtensionWireJson(await response.text()) : null
  if (!isReply(reply) || !reply.ok || connection !== current || current.controller.signal.aborted) {
    throw new Error('Extension worker publication failed')
  }
}

function enqueueListen(current: WorkerConnection, request: unknown): void {
  current.chain = current.chain.then(() => publish(current, request))
  void current.chain.catch(() => current.controller.abort())
}

function sendListen(namespace: string, event: string, active: boolean, filters?: unknown[]): void {
  if (connection) {
    enqueueListen(connection, { type: 'listen', namespace, event, active, filters })
  }
}

async function connectEvents(): Promise<void> {
  const token = await tokenReady
  while (token) {
    const controller = new AbortController()
    const id = crypto.randomUUID()
    let current: WorkerConnection | null = null
    try {
      const response = await post(
        BROWSER_EXTENSION_API_EVENTS_URL,
        { token, connectionId: id },
        controller.signal
      )
      if (response.status === 403) {
        return
      }
      if (!response.ok || !response.body) {
        throw new Error('Extension worker connection was refused')
      }
      current = { id, controller, chain: Promise.resolve(), ready: Promise.resolve() }
      connection = current
      openedConnection(current)
      for (const entry of listening.values()) {
        enqueueListen(current, { type: 'listen', ...entry, active: true })
      }
      const publishing = current
      current.ready = evaluationComplete.then(async () => {
        // Queue the checkpoint after synchronous original-worker registration and ordered replay.
        publishing.chain = publishing.chain.then(() => publish(publishing, { type: 'published' }))
        await publishing.chain
      })
      void current.ready.catch(() => controller.abort())
      await readLines(response.body)
    } catch {
      // The existing reconnect replays the actual listeners on a fresh connection.
    } finally {
      controller.abort()
      if (connection === current) {
        connection = null
        nextConnection = new Promise<WorkerConnection>((resolve) => {
          openedConnection = resolve
        })
      }
    }
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS))
  }
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
installBrowserExtensionStorageSync(bridge, { QUOTA_BYTES: 10_485_760 }, undefined, 'session')
installBrowserExtensionNativeMessaging(bridge, 'worker')
installBrowserExtensionMessageTargets(bridge, PRELOAD_FIRST_DISCARDED_TAB_ID)
installBrowserExtensionDocumentTargets(bridge, PRELOAD_FIRST_DISCARDED_TAB_ID, {
  file: 'ORCA_EXTENSION_OWN_PREFIX',
  execution: 'ORCA_EXTENSION_OWN_EXECUTION'
})
installBrowserExtensionInertApis('worker')
installContentScriptRelayFilter(
  installBrowserExtensionStorageSync(
    bridge,
    PRELOAD_STORAGE_SYNC_CONSTANTS,
    createContentScriptSyncForward() ?? undefined
  ) ?? undefined
)
