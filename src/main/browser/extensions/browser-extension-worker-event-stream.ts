import type { BrowserExtensionEventPayload } from '../../../shared/browser-extension-channels'
import type { WorkerContext } from './browser-extension-contexts'

/** The worker's open events response; `send` throws once the worker has gone. */
export type WorkerEventStream = {
  send: (payload: BrowserExtensionEventPayload) => void
  close: () => void
}

/** A new stream replaces the old one: one worker runs per extension per session. */
export function attachWorkerEventStream(context: WorkerContext, stream: WorkerEventStream): void {
  if (context.stream !== stream) {
    context.stream?.close()
  }
  context.stream = stream
}

/** Omit `stream` to drop whatever is attached (the worker stopped). */
export function detachWorkerEventStream(context: WorkerContext, stream?: WorkerEventStream): void {
  if (!context.stream || (stream && context.stream !== stream)) {
    return
  }
  const closing = context.stream
  context.stream = null
  closing.close()
}

// Why: Chrome restarts a worker's idle timer on every event; ending a task does the same here.
function extendWorkerLifetime(worker: Electron.ServiceWorkerMain | null): void {
  try {
    if (worker && !worker.isDestroyed()) {
      worker.startTask().end()
    }
  } catch {
    // The worker is stopping; the event already went out or will be queued.
  }
}

/** False when no stream is open (the worker is stopped or starting): the caller queues. */
export function sendToWorkerEventStream(
  context: WorkerContext,
  payload: BrowserExtensionEventPayload
): boolean {
  const stream = context.stream
  if (!stream) {
    return false
  }
  try {
    stream.send(payload)
  } catch {
    detachWorkerEventStream(context, stream)
    return false
  }
  extendWorkerLifetime(context.running)
  return true
}

export type QueuedWorkerEvent = {
  key: string
  payload: BrowserExtensionEventPayload
  queuedAt: number
}

type StartWorker = (sess: Electron.Session, context: WorkerContext) => void

const MAX_QUEUED_EVENTS = 100
const QUEUED_EVENT_TTL_MS = 30_000

/** Delivers queued events to a (re)started worker once it registers the matching listener. */
export function flushWorkerQueue(context: WorkerContext, key: string): void {
  if (!context.stream) {
    return
  }
  const now = Date.now()
  const remaining: QueuedWorkerEvent[] = []
  for (const queued of context.queue) {
    if (now - queued.queuedAt > QUEUED_EVENT_TTL_MS) {
      continue
    }
    if (queued.key !== key || !sendToWorkerEventStream(context, queued.payload)) {
      remaining.push(queued)
    }
  }
  context.queue = remaining
}

/** Holds the event until the listener registers; unheard events expire or are evicted. */
export function queueWorkerEvent(
  sess: Electron.Session,
  context: WorkerContext,
  key: string,
  payload: BrowserExtensionEventPayload,
  startWorker: StartWorker
): void {
  context.queue.push({ key, payload, queuedAt: Date.now() })
  if (context.queue.length > MAX_QUEUED_EVENTS) {
    context.queue.shift()
  }
  startWorker(sess, context)
}

export function deliverToWorker(
  sess: Electron.Session,
  context: WorkerContext,
  key: string,
  payload: BrowserExtensionEventPayload,
  startWorker: StartWorker
): void {
  if (!sendToWorkerEventStream(context, payload)) {
    queueWorkerEvent(sess, context, key, payload, startWorker)
  }
}
