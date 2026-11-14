import type { BrowserExtensionEventPayload } from '../../../../shared/browser/extensions/browser-extension-channels'
import type { WorkerContext } from './browser-extension-contexts'

/** The worker's open events response; `send` throws once the worker has gone. */
export type WorkerEventStream = {
  connectionId: string
  controller: AbortController
  events: Set<string>
  filters: Map<string, unknown[]>
  published: boolean
  send: (payload: BrowserExtensionEventPayload) => void
  close: () => void
}

/** A new stream replaces the old one: one worker runs per extension per session. */
export function attachWorkerEventStream(context: WorkerContext, stream: WorkerEventStream): void {
  if (context.stream !== stream) {
    context.stream?.close()
  }
  context.stream = stream
  beginWorkerPublication(context)
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
  provisional?: boolean
  matchesFilter?: (filter: unknown) => boolean
  resolve?: () => BrowserExtensionEventPayload | null
}

type StartWorker = (sess: Electron.Session, context: WorkerContext) => void

const MAX_QUEUED_EVENTS = 100
const QUEUED_EVENT_TTL_MS = 30_000

export function beginWorkerPublication(context: WorkerContext, newRun = false): void {
  if (context.publicationUntil === undefined || newRun || context.publicationComplete) {
    context.publicationComplete = false
    context.publicationUntil = Date.now() + QUEUED_EVENT_TTL_MS
    context.initialPublication = true
  }
}

/** Unknown subscriptions stop costing work after their existing event-retention window. */
export function isWorkerPublishing(context: WorkerContext): boolean {
  return context.initialPublication === true && Date.now() < (context.publicationUntil ?? 0)
}

/** Delivers queued events to a (re)started worker once it registers the matching listener. */
export function flushWorkerQueue(context: WorkerContext, key: string): void {
  const stream = context.stream
  if (!stream || !stream.events.has(key)) {
    return
  }
  const now = Date.now()
  const remaining: QueuedWorkerEvent[] = []
  for (const queued of context.queue) {
    if (now - queued.queuedAt > QUEUED_EVENT_TTL_MS) {
      continue
    }
    const filters = stream.filters.get(key)
    const matches = !queued.matchesFilter || !filters || filters.some(queued.matchesFilter)
    if (queued.key !== key || !matches) {
      remaining.push(queued)
      continue
    }
    const payload = queued.resolve ? queued.resolve() : queued.payload
    if (payload && !sendToWorkerEventStream(context, payload)) {
      remaining.push(queued)
    } else if (payload && payload.namespace === 'runtime') {
      context.pendingLifecycle = context.pendingLifecycle?.filter(
        (entry) => entry !== queued.payload
      )
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
  startWorker: StartWorker,
  admission?: Pick<QueuedWorkerEvent, 'provisional' | 'matchesFilter' | 'resolve'>,
  wake = true
): void {
  context.queue.push({ key, payload, queuedAt: Date.now(), ...admission })
  if (context.queue.length > MAX_QUEUED_EVENTS) {
    const provisional = context.queue.findIndex((entry) => entry.provisional)
    const [evicted] = context.queue.splice(provisional === -1 ? 0 : provisional, 1)
    context.pendingLifecycle = context.pendingLifecycle?.filter(
      (entry) => entry !== evicted.payload
    )
  }
  if (wake) {
    startWorker(sess, context)
  }
}

export function deliverToWorker(
  sess: Electron.Session,
  context: WorkerContext,
  key: string,
  payload: BrowserExtensionEventPayload,
  startWorker: StartWorker,
  admission?: Pick<QueuedWorkerEvent, 'provisional' | 'matchesFilter' | 'resolve'>
): void {
  if (!context.stream?.events.has(key) || !sendToWorkerEventStream(context, payload)) {
    queueWorkerEvent(sess, context, key, payload, startWorker, admission)
  } else if (payload.namespace === 'runtime') {
    context.pendingLifecycle = context.pendingLifecycle?.filter((entry) => entry !== payload)
  }
}
