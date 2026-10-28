import { abortWhenRendererGone } from '../../ipc/renderer-lifetime-abort'
import { forgetBrowserExtensionContextLifetime } from './browser-extension-context-lifetime'
import { webFrameMain } from 'electron'
import {
  BROWSER_EXTENSION_EVENT_CHANNEL,
  type BrowserExtensionEventPayload
} from '../../../shared/browser-extension-channels'
import { getChromeExtensionOrigin } from '../../../shared/browser-extension-url'
import {
  extensionHasNamespacePermission,
  getBrowserExtensionNamespace
} from './browser-extension-namespace-registry'
import {
  deliverToWorker,
  detachWorkerEventStream,
  queueWorkerEvent,
  type QueuedWorkerEvent,
  type WorkerEventStream
} from './browser-extension-worker-event-stream'

type FrameContext = {
  extensionId: string
  webContentsId: number
  processId: number
  routingId: number
  events: Set<string>
  filters: ListenerFilters
}

/** Event key → every listener's filter; absent when some listener takes everything. */
export type ListenerFilters = Map<string, unknown[]>

/** Listener registrations outlive the worker: a stopped worker is restarted when one fires. */
export type WorkerContext = {
  extensionId: string
  scope: string
  events: Set<string>
  filters: ListenerFilters
  /** Held only for startTask(); events travel over `stream`. */
  running: Electron.ServiceWorkerMain | null
  stream: WorkerEventStream | null
  queue: QueuedWorkerEvent[]
  starting: boolean
}

export type HostSessionState = {
  browserProfileId: string
  frames: Map<string, FrameContext>
  workers: Map<string, WorkerContext>
}

const stateBySession = new Map<Electron.Session, HostSessionState>()
const trackedWebContents = new WeakSet<Electron.WebContents>()

export function eventKey(namespace: string, event: string): string {
  return `${namespace}.${event}`
}

export function getHostSessionState(sess: Electron.Session): HostSessionState | null {
  return stateBySession.get(sess) ?? null
}

export function ensureHostSessionState(
  sess: Electron.Session,
  browserProfileId: string
): HostSessionState {
  let state = stateBySession.get(sess)
  if (!state) {
    state = { browserProfileId, frames: new Map(), workers: new Map() }
    stateBySession.set(sess, state)
  }
  return state
}

export function forgetHostSession(sess: Electron.Session): void {
  forgetBrowserExtensionContextLifetime(stateBySession.get(sess))
  for (const context of stateBySession.get(sess)?.workers.values() ?? []) {
    detachWorkerEventStream(context)
  }
  stateBySession.delete(sess)
}

export function forgetExtensionContexts(sess: Electron.Session, extensionId: string): void {
  const state = stateBySession.get(sess)
  if (!state) {
    return
  }
  forgetBrowserExtensionContextLifetime(state, extensionId)
  const worker = state.workers.get(extensionId)
  if (worker) {
    detachWorkerEventStream(worker)
  }
  state.workers.delete(extensionId)
  for (const [key, frame] of state.frames) {
    if (frame.extensionId === extensionId) {
      state.frames.delete(key)
    }
  }
}

export function ensureWorkerContext(
  state: HostSessionState,
  extensionId: string,
  scope: string
): WorkerContext {
  let context = state.workers.get(extensionId)
  if (!context) {
    context = {
      extensionId,
      scope,
      events: new Set(),
      filters: new Map(),
      running: null,
      stream: null,
      queue: [],
      starting: false
    }
    state.workers.set(extensionId, context)
  }
  return context
}

export function setFrameListening(
  state: HostSessionState,
  extensionId: string,
  webContents: Electron.WebContents,
  frame: Electron.WebFrameMain,
  key: string,
  active: boolean,
  filters?: unknown[]
): void {
  const frameKey = `${webContents.id}:${frame.processId}:${frame.routingId}`
  let context = state.frames.get(frameKey)
  if (!context) {
    if (!active) {
      return
    }
    context = {
      extensionId,
      webContentsId: webContents.id,
      processId: frame.processId,
      routingId: frame.routingId,
      events: new Set(),
      filters: new Map()
    }
    state.frames.set(frameKey, context)
  }
  if (active) {
    context.events.add(key)
  } else {
    context.events.delete(key)
  }
  setListenerFilters(context.filters, key, active ? filters : undefined)
  if (!trackedWebContents.has(webContents)) {
    trackedWebContents.add(webContents)
    const { session: webSession, id: webContentsId } = webContents
    abortWhenRendererGone(webContents).signal.addEventListener('abort', () => {
      trackedWebContents.delete(webContents)
      stateBySession.get(webSession)?.frames.forEach((candidate, candidateKey, frames) => {
        if (candidate.webContentsId === webContentsId) {
          frames.delete(candidateKey)
        }
      })
    })
  }
}

export function setListenerFilters(
  filters: ListenerFilters,
  key: string,
  next: unknown[] | undefined
): void {
  if (next && next.length > 0) {
    filters.set(key, next)
  } else {
    filters.delete(key)
  }
}

function listensFor(
  context: { events: Set<string>; filters: ListenerFilters },
  key: string,
  matchesFilter: ((filter: unknown) => boolean) | undefined
): boolean {
  if (!context.events.has(key)) {
    return false
  }
  const filters = matchesFilter ? context.filters.get(key) : undefined
  return !filters || filters.some((filter) => matchesFilter?.(filter))
}

/**
 * For events fired as the worker starts (runtime.onInstalled): its top-level listeners reach main
 * a moment later, so the event waits in the queue for them instead of being skipped.
 */
export function dispatchToWorkerWhenListening(
  sess: Electron.Session,
  extensionId: string,
  namespace: string,
  event: string,
  args: unknown[],
  startWorker: (sess: Electron.Session, context: WorkerContext) => void
): void {
  const state = stateBySession.get(sess)
  if (!state) {
    return
  }
  const key = eventKey(namespace, event)
  const scope = `${getChromeExtensionOrigin(extensionId)}/`
  const context = ensureWorkerContext(state, extensionId, scope)
  const payload: BrowserExtensionEventPayload = { namespace, event, args }
  if (context.events.has(key)) {
    deliverToWorker(sess, context, key, payload, startWorker)
  } else {
    queueWorkerEvent(sess, context, key, payload, startWorker)
  }
}

function isFrame(context: FrameContext, frame: Electron.WebFrameMain | undefined): boolean {
  return context.processId === frame?.processId && context.routingId === frame.routingId
}

function deliverToFrames(
  state: HostSessionState,
  extensionId: string,
  key: string,
  payload: BrowserExtensionEventPayload,
  matchesFilter: ((filter: unknown) => boolean) | undefined,
  exceptFrame: Electron.WebFrameMain | undefined
): void {
  const origin = `${getChromeExtensionOrigin(extensionId)}/`
  for (const [frameKey, context] of state.frames) {
    if (
      context.extensionId !== extensionId ||
      isFrame(context, exceptFrame) ||
      !listensFor(context, key, matchesFilter)
    ) {
      continue
    }
    const frame = webFrameMain.fromId(context.processId, context.routingId)
    // Why: a frame that navigated away from the extension must stop receiving its events.
    if (!frame || frame.isDestroyed() || !frame.url.startsWith(origin)) {
      state.frames.delete(frameKey)
      continue
    }
    try {
      frame.send(BROWSER_EXTENSION_EVENT_CHANNEL, payload)
    } catch {
      state.frames.delete(frameKey)
    }
  }
}

export type BrowserExtensionEventTarget = {
  /** Only extensions loaded in this session; omit to reach every extension session. */
  session?: Electron.Session
  extensionId?: string
  /** The calling page frame or worker, which delivers this event to itself. */
  exceptCaller?: { frame?: Electron.WebFrameMain; fromWorker?: boolean }
}

/** Per-extension args let an event hide fields an extension may not see; null skips it. */
export type BrowserExtensionEventArgs =
  | unknown[]
  | ((extension: Electron.Extension, session: Electron.Session) => unknown[] | null)

function listeningExtensionIds(state: HostSessionState, key: string): Set<string> {
  const contexts = [...state.workers.values(), ...state.frames.values()]
  return new Set(contexts.filter((c) => c.events.has(key)).map((c) => c.extensionId))
}

/** Cheap pre-check for hot paths (webRequest) before they build an event's details. */
export function browserExtensionEventHasListener(
  sess: Electron.Session,
  namespace: string,
  event: string
): boolean {
  const state = stateBySession.get(sess)
  return state !== undefined && listeningExtensionIds(state, eventKey(namespace, event)).size > 0
}

export function dispatchBrowserExtensionEvent(
  target: BrowserExtensionEventTarget,
  namespace: string,
  event: string,
  args: BrowserExtensionEventArgs,
  startWorker: (sess: Electron.Session, context: WorkerContext) => void,
  matchesFilter?: (filter: unknown) => boolean
): void {
  const permission = getBrowserExtensionNamespace(namespace)?.permission
  const key = eventKey(namespace, event)
  for (const [sess, state] of stateBySession) {
    if (target.session && target.session !== sess) {
      continue
    }
    // Why: getAllExtensions() copies every manifest out of C++; webRequest fires this per request.
    for (const extensionId of listeningExtensionIds(state, key)) {
      if (target.extensionId && extensionId !== target.extensionId) {
        continue
      }
      const extension = sess.extensions.getExtension(extensionId)
      if (!extension) {
        continue
      }
      if (!extensionHasNamespacePermission(extension, permission, sess)) {
        continue
      }
      const worker = target.exceptCaller?.fromWorker ? undefined : state.workers.get(extension.id)
      const workerListens = worker ? listensFor(worker, key, matchesFilter) : false
      const exceptFrame = target.exceptCaller?.frame
      const frameListens = [...state.frames.values()].some(
        (frame) =>
          frame.extensionId === extension.id &&
          !isFrame(frame, exceptFrame) &&
          listensFor(frame, key, matchesFilter)
      )
      if (!workerListens && !frameListens) {
        continue
      }
      const resolvedArgs = typeof args === 'function' ? args(extension, sess) : args
      if (!resolvedArgs) {
        continue
      }
      const payload: BrowserExtensionEventPayload = { namespace, event, args: resolvedArgs }
      if (worker && workerListens) {
        deliverToWorker(sess, worker, key, payload, startWorker)
      }
      if (frameListens) {
        deliverToFrames(state, extension.id, key, payload, matchesFilter, exceptFrame)
      }
    }
  }
}
