import { ipcMain, type Session, type ServiceWorkerMain, type WebFrameMain } from 'electron'
import {
  BROWSER_EXTENSION_CALL_CHANNEL,
  BROWSER_EXTENSION_EVENT_CHANNEL
} from '../../../shared/browser-extension-channels'

/** The extension context behind an API call. */
export type ExtensionCaller = {
  extension: Electron.Extension
  session: Session
  /** The extension page's frame; null when the caller is its service worker. */
  frame: WebFrameMain | null
}

// Why any[]: each handler declares its own parameters, as unknown, and checks them.
type Handler = (caller: ExtensionCaller, ...args: any[]) => unknown

type Listening = {
  worker: Set<string>
  frames: Map<WebFrameMain, Set<string>>
}

type PendingEvent = { key: string; args: unknown[]; at: number }

const handlers = new Map<string, Handler>()
// Events for extensions whose worker has not run yet, by session then extension id.
const pendingBySession = new WeakMap<Session, Map<string, PendingEvent[]>>()
const PENDING_EVENT_TTL_MS = 10_000
const listeningBySession = new WeakMap<Session, Map<string, Listening>>()
const attachedWorkers = new WeakSet<ServiceWorkerMain>()
let frameCallsHandled = false

/** Registers `chrome.<namespace>.<method>` implementations. */
export function handleExtensionApi(namespace: string, methods: Record<string, Handler>): void {
  for (const [method, handler] of Object.entries(methods)) {
    handlers.set(`${namespace}.${method}`, handler)
  }
}

/**
 * Fires `key` ("namespace.event") in every context of the session's extensions that listens for
 * it, or only `extensionId`'s. A service worker that has stopped is started to receive it.
 */
export function emitExtensionEvent(
  session: Session,
  key: string,
  args: unknown[],
  extensionId?: string
): void {
  const listening = listeningBySession.get(session)
  for (const [id, contexts] of listening ?? []) {
    if (extensionId === undefined || id === extensionId) {
      deliver(session, id, contexts, key, args)
    }
  }
  // Why: a worker that has never run has told us none of its listeners; Chrome remembers them
  // across restarts, so hold the event until the worker registers and see if it wants it.
  const waiting =
    extensionId === undefined
      ? session.extensions.getAllExtensions()
      : [session.extensions.getExtension(extensionId)]
  for (const extension of waiting) {
    if (extension && !listening?.has(extension.id) && hasServiceWorker(extension)) {
      let pending = pendingBySession.get(session)
      if (!pending) {
        pending = new Map()
        pendingBySession.set(session, pending)
      }
      const now = Date.now()
      const kept = (pending.get(extension.id) ?? []).filter(
        (each) => now - each.at < PENDING_EVENT_TTL_MS
      )
      pending.set(extension.id, [...kept, { key, args, at: now }])
    }
  }
}

function hasServiceWorker(extension: Electron.Extension): boolean {
  return Boolean(Reflect.get(Object(extension.manifest.background), 'service_worker'))
}

/** Fires `key` in the one context that made `caller`'s call, e.g. for its native port. */
export function emitToExtensionCaller(caller: ExtensionCaller, key: string, args: unknown[]): void {
  if (caller.frame) {
    if (!caller.frame.isDestroyed()) {
      caller.frame.send(BROWSER_EXTENSION_EVENT_CHANNEL, key, args)
    }
    return
  }
  sendToWorker(caller.session, caller.extension.id, key, args)
}

function deliver(
  session: Session,
  extensionId: string,
  contexts: Listening,
  key: string,
  args: unknown[]
): void {
  if (contexts.worker.has(key)) {
    sendToWorker(session, extensionId, key, args)
  }
  for (const [frame, keys] of contexts.frames) {
    if (frame.isDestroyed()) {
      contexts.frames.delete(frame)
    } else if (keys.has(key)) {
      frame.send(BROWSER_EXTENSION_EVENT_CHANNEL, key, args)
    }
  }
}

function sendToWorker(session: Session, extensionId: string, key: string, args: unknown[]): void {
  session.serviceWorkers
    .startWorkerForScope(`chrome-extension://${extensionId}/`)
    .then((worker) => worker.send(BROWSER_EXTENSION_EVENT_CHANNEL, key, args))
    .catch(() => {
      // The extension has no service worker, or it was unloaded meanwhile.
    })
}

// Why retry: at "extension-ready" the worker's registration may not exist yet.
const WORKER_START_ATTEMPTS = 5
const WORKER_START_RETRY_MS = 200

function startWorker(session: Session, extension: Electron.Extension, attempts: number): void {
  session.serviceWorkers.startWorkerForScope(extension.url).catch(() => {
    if (attempts > 1 && session.extensions.getExtension(extension.id)) {
      setTimeout(() => startWorker(session, extension, attempts - 1), WORKER_START_RETRY_MS)
    }
  })
}

function listen(caller: ExtensionCaller, key: string): void {
  let listening = listeningBySession.get(caller.session)
  if (!listening) {
    listening = new Map()
    listeningBySession.set(caller.session, listening)
  }
  let contexts = listening.get(caller.extension.id)
  if (!contexts) {
    contexts = { worker: new Set(), frames: new Map() }
    listening.set(caller.extension.id, contexts)
  }
  if (caller.frame) {
    const keys = contexts.frames.get(caller.frame) ?? new Set()
    contexts.frames.set(caller.frame, keys.add(key))
    return
  }
  contexts.worker.add(key)
  const pending = pendingBySession.get(caller.session)
  const held = pending?.get(caller.extension.id)
  if (held) {
    const now = Date.now()
    const due = held.filter((each) => each.key === key && now - each.at < PENDING_EVENT_TTL_MS)
    pending?.set(
      caller.extension.id,
      held.filter((each) => each.key !== key)
    )
    for (const each of due) {
      sendToWorker(caller.session, caller.extension.id, each.key, each.args)
    }
  }
}

async function dispatch(caller: ExtensionCaller | null, call: unknown): Promise<unknown> {
  if (!caller) {
    throw new Error('Not an extension context')
  }
  const namespace: unknown = Reflect.get(Object(call), 'namespace')
  const method: unknown = Reflect.get(Object(call), 'method')
  const args: unknown = Reflect.get(Object(call), 'args')
  if (typeof namespace !== 'string' || typeof method !== 'string' || !Array.isArray(args)) {
    throw new Error('Malformed extension API call')
  }
  if (namespace === 'events' && method === 'listen' && typeof args[0] === 'string') {
    listen(caller, args[0])
    return undefined
  }
  const handler = handlers.get(`${namespace}.${method}`)
  if (!handler) {
    throw new Error(`chrome.${namespace}.${method} is not supported in Orca`)
  }
  return handler(caller, ...args)
}

function extensionFromUrl(session: Session, url: string): Electron.Extension | null {
  const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(url)
  return (match && session.extensions.getExtension(match[1])) ?? null
}

/** Serves Orca's chrome.* APIs to the session's extension pages and service workers. */
export function installExtensionApiHost(session: Session, preloadPath: string): void {
  for (const type of ['frame', 'service-worker'] as const) {
    session.registerPreloadScript({
      id: `orca-browser-extension-api-${type}`,
      type,
      filePath: preloadPath
    })
  }
  // Why start it: a worker registers its event listeners as its script first runs, and events
  // reach only contexts that registered; Chrome instead remembers listeners across restarts.
  session.extensions.on('extension-ready', (_event, extension) => {
    if (hasServiceWorker(extension)) {
      startWorker(session, extension, WORKER_START_ATTEMPTS)
    }
  })
  // Why at "starting": the worker registers listeners as its script first runs, before "running".
  session.serviceWorkers.on('running-status-changed', ({ versionId }) => {
    const worker = session.serviceWorkers.getWorkerFromVersionID(versionId)
    if (!worker || attachedWorkers.has(worker)) {
      return
    }
    attachedWorkers.add(worker)
    worker.ipc.handle(BROWSER_EXTENSION_CALL_CHANNEL, (_event, call: unknown) => {
      const extension = extensionFromUrl(session, worker.scope)
      return dispatch(extension && { extension, session, frame: null }, call)
    })
  })
  if (!frameCallsHandled) {
    frameCallsHandled = true
    ipcMain.handle(BROWSER_EXTENSION_CALL_CHANNEL, (event, call: unknown) => {
      const frame = event.senderFrame
      const extension = frame && extensionFromUrl(event.sender.session, frame.url)
      return dispatch(
        extension && frame && { extension, session: event.sender.session, frame },
        call
      )
    })
  }
}
