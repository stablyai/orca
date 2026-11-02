import { forgetBrowserExtensionContextLifetime } from './browser-extension-context-lifetime'
import {
  createBrowserExtensionFrameContext,
  forgetBrowserExtensionFrame,
  trackBrowserExtensionDocument,
  type FrameContext
} from './browser-extension-frame-lifetime'
import type { BrowserExtensionEventPayload } from '../../../shared/browser-extension-channels'
import { getChromeExtensionOrigin } from '../../../shared/browser-extension-url'
import {
  dispatchBrowserExtensionEvent as dispatchEvent,
  eventKey,
  type BrowserExtensionEventArgs,
  type BrowserExtensionEventTarget
} from './browser-extension-event-dispatch'

export { eventKey } from './browser-extension-event-dispatch'
export type {
  BrowserExtensionEventArgs,
  BrowserExtensionEventTarget
} from './browser-extension-event-dispatch'
import {
  deliverToWorker,
  detachWorkerEventStream,
  queueWorkerEvent,
  type QueuedWorkerEvent,
  type WorkerEventStream
} from './browser-extension-worker-event-stream'

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
  const state = stateBySession.get(sess)
  forgetBrowserExtensionContextLifetime(state)
  if (state) {
    for (const [key, context] of state.frames) {
      forgetBrowserExtensionFrame(state.frames, key, context)
    }
  }
  for (const context of state?.workers.values() ?? []) {
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
      forgetBrowserExtensionFrame(state.frames, key, frame)
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
    context = createBrowserExtensionFrameContext(
      state.frames,
      frameKey,
      extensionId,
      webContents.id,
      frame
    )
  }
  if (active) {
    context.events.add(key)
  } else {
    context.events.delete(key)
  }
  setListenerFilters(context.filters, key, active ? filters : undefined)
  if (context.events.size === 0) {
    forgetBrowserExtensionFrame(state.frames, frameKey, context)
  }
  const webSession = webContents.session
  trackBrowserExtensionDocument(webContents, () => stateBySession.get(webSession)?.frames)
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

/** Cheap pre-check for hot paths (webRequest) before they build an event's details. */
export function browserExtensionEventHasListener(
  sess: Electron.Session,
  namespace: string,
  event: string
): boolean {
  const state = stateBySession.get(sess)
  const key = eventKey(namespace, event)
  for (const context of state?.workers.values() ?? []) {
    if (context.events.has(key)) {
      return true
    }
  }
  for (const context of state?.frames.values() ?? []) {
    if (context.events.has(key)) {
      return true
    }
  }
  return false
}

export function dispatchBrowserExtensionEvent(
  target: BrowserExtensionEventTarget,
  namespace: string,
  event: string,
  args: BrowserExtensionEventArgs,
  startWorker: (sess: Electron.Session, context: WorkerContext) => void,
  matchesFilter?: (filter: unknown) => boolean
): void {
  dispatchEvent(stateBySession, target, namespace, event, args, startWorker, matchesFilter)
}
