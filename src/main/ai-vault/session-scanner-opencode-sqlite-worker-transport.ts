import type {
  OpenCodeSqliteListRequest,
  OpenCodeSqliteParseRequest,
  OpenCodeSqliteWorkerRequest,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'
import {
  MAX_CONSECUTIVE_OPENCODE_WORKER_DEATHS,
  MAX_CONSECUTIVE_OPENCODE_WORKER_TIMEOUTS,
  MAX_CONSECUTIVE_OPENCODE_WORKER_UNAVAILABLE,
  type OpenCodeSqliteScanContext
} from './session-scanner-opencode-sqlite-scan-context'
import {
  OpenCodeSqliteWorkerHandle,
  type WorkerFactory
} from './session-scanner-opencode-sqlite-worker-handle'

export {
  IDLE_TEARDOWN_MS,
  TERMINATE_GRACE_MS,
  type WorkerFactory
} from './session-scanner-opencode-sqlite-worker-handle'

// Why (#8864): a lazily-spawned, unref'd worker runs OpenCode SQLite reads off
// the main-process event loop. Lifecycle (idle teardown, FIFO one-at-a-time
// dispatch, per-call timeouts, respawn-on-fault) mirrors src/main/speech/
// stt-service.ts. The default spawn + shared singleton live in
// session-scanner-opencode-sqlite-worker-spawn.ts.

// Why: scan-owned fault state survives queue-empty batch gaps without affecting
// overlapping scans.
export const MAX_CONSECUTIVE_DEATHS = MAX_CONSECUTIVE_OPENCODE_WORKER_DEATHS
export const MAX_CONSECUTIVE_TIMEOUTS = MAX_CONSECUTIVE_OPENCODE_WORKER_TIMEOUTS
export const MAX_CONSECUTIVE_UNAVAILABLE = MAX_CONSECUTIVE_OPENCODE_WORKER_UNAVAILABLE

// Omit<union, 'id'> collapses to the shared keys, so omit each member and let
// the client stamp the correlation id.
type OpenCodeSqliteRequestBody =
  | Omit<OpenCodeSqliteListRequest, 'id'>
  | Omit<OpenCodeSqliteParseRequest, 'id'>

type PendingCall = {
  request: OpenCodeSqliteWorkerRequest
  context: OpenCodeSqliteScanContext
  enqueuedAtMs: number
  queueWaitRecorded: boolean
  activeAtMs: number | null
  timeoutMs: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

// Distinguishes "no worker available at all" from a timeout or crash so callers
// can surface a precise issue while keeping synchronous SQLite off the main thread.
export class OpenCodeSqliteWorkerUnavailableError extends Error {}
export class OpenCodeSqliteWorkerTimeoutError extends Error {}
export class OpenCodeSqliteWorkerFaultError extends Error {
  constructor(
    message: string,
    readonly cause?: Error
  ) {
    super(message)
    this.name = 'OpenCodeSqliteWorkerFaultError'
  }
}

/**
 * Worker transport that runs OpenCode SQLite reads on a persistent worker
 * thread. Dispatches one request at a time (FIFO), times each request out from
 * dispatch, respawns after faults (capped separately by `MAX_CONSECUTIVE_DEATHS`
 * and `MAX_CONSECUTIVE_TIMEOUTS`) once the previous thread is confirmed dead,
 * tears the worker down after `IDLE_TEARDOWN_MS` of inactivity, and fails closed
 * when no worker can be spawned rather than moving SQLite work onto the main
 * thread. The instance is shared across concurrent scans, so every failure path
 * is scoped to the calls it actually owns.
 */
export class OpenCodeSqliteWorkerTransport {
  private active: PendingCall | null = null
  private queue: PendingCall[] = []
  private nextId = 1
  private readonly contextAbortListeners = new Map<OpenCodeSqliteScanContext, () => void>()
  private readonly handle: OpenCodeSqliteWorkerHandle

  constructor(options: { workerFactory: WorkerFactory; log?: (message: string) => void }) {
    this.handle = new OpenCodeSqliteWorkerHandle({
      workerFactory: options.workerFactory,
      log: options.log ?? ((message) => console.warn(message)),
      onMessage: (response) => this.onMessage(response),
      onFault: (error) => this.onWorkerFault(error),
      onExit: (code) => this.onWorkerExit(code),
      onTeardownSettled: () => this.pump()
    })
  }

  dispatch(
    request: OpenCodeSqliteRequestBody,
    timeoutMs: number,
    context: OpenCodeSqliteScanContext
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (context.isTerminated) {
        context.markWorkOmitted()
        reject(context.terminationError())
        return
      }
      const id = this.nextId++
      this.queue.push({
        request: { ...request, id } as OpenCodeSqliteWorkerRequest,
        context,
        enqueuedAtMs: Date.now(),
        queueWaitRecorded: false,
        activeAtMs: null,
        timeoutMs,
        resolve,
        reject,
        timer: null
      })
      this.ensureContextAbortListener(context)
      this.pump()
    })
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) {
      return
    }
    // A replacement thread must not start until the previous one is confirmed
    // dead; the teardown re-pumps once it settles.
    if (this.handle.isTearingDown) {
      return
    }
    const worker = this.handle.ensure()
    if (!worker) {
      this.failHeadAsUnavailable()
      return
    }
    const call = this.queue.shift()
    if (!call) {
      return
    }
    this.active = call
    this.handle.clearIdleTimer()
    call.activeAtMs = Date.now()
    this.recordQueueWait(call, call.activeAtMs)
    // Timeout clock starts at dispatch (not enqueue): a batch may enqueue up to
    // 8 parses at once, and a queue-inclusive timeout would fire falsely.
    call.timer = setTimeout(() => this.onTimeout(call), call.timeoutMs)
    call.timer.unref?.()
    try {
      worker.postMessage(call.request)
    } catch (err) {
      this.onWorkerFault(err instanceof Error ? err : new Error(String(err)))
    }
  }

  private onMessage(response: OpenCodeSqliteWorkerResponse): void {
    const call = this.active
    if (!call || call.request.id !== response.id) {
      return
    }
    call.context.noteWorkerResponse()
    if (call.request.kind === 'parse' && response.ok) {
      call.context.noteParseResponse()
    }
    if (response.ok) {
      this.settle(call, () => call.resolve(response.value))
    } else {
      this.settle(call, () => call.reject(new Error(response.error)))
    }
    this.releaseContextAbortListenerIfUnused(call.context)
    this.afterSettle()
  }

  // A timeout is not a death: the thread is very likely still alive and grinding
  // through a slow query. It still costs us the worker (we cannot cancel the
  // query, so the thread is unusable), but it is counted and reported separately
  // so a merely-slow database is never described to the user as a crash.
  private onTimeout(call: PendingCall): void {
    if (this.active !== call) {
      return
    }
    const error = new OpenCodeSqliteWorkerTimeoutError(
      `OpenCode SQLite worker timed out after ${call.timeoutMs}ms`
    )
    const failed = call
    this.handle.destroy()
    const shouldTrip = failed.context.noteWorkerTimeout()
    this.settle(failed, () => failed.reject(error))
    if (shouldTrip) {
      failed.context.tripTimeoutCircuit(error)
      return
    }
    this.releaseContextAbortListenerIfUnused(failed.context)
    if (this.queue.length > 0) {
      this.pump()
    }
  }

  private onWorkerExit(code: number): void {
    // A clean self-exit is not a death, but the stale handle must be dropped
    // or the next dispatch would post into the dead worker and stall to timeout.
    if (code === 0 && !this.active && this.queue.length === 0) {
      this.handle.destroy()
      return
    }
    this.onWorkerFault(new Error(`OpenCode SQLite worker exited with code ${code}`))
  }

  private onWorkerFault(error: Error): void {
    const failed = this.active
    this.handle.destroy()
    const shouldTrip = failed?.context.noteWorkerDeath() ?? false
    if (failed) {
      this.settle(failed, () =>
        failed.reject(new OpenCodeSqliteWorkerFaultError(error.message, error))
      )
    }
    if (failed && shouldTrip) {
      failed.context.tripCircuit(error)
      return
    }
    if (failed) {
      this.releaseContextAbortListenerIfUnused(failed.context)
    }
    if (this.queue.length > 0) {
      this.pump()
    }
  }

  // Why: the transport is shared by every concurrent scan. Draining the whole
  // queue on one spawn failure would let a single transient failure erase every
  // in-flight scan's OpenCode history, so only the head call is failed and the
  // next pump re-tries the factory for whoever is behind it. The owning scan
  // still counts the failure, so a worker that never spawns gives up after
  // MAX_CONSECUTIVE_UNAVAILABLE instead of being retried once per candidate.
  private failHeadAsUnavailable(): void {
    const call = this.queue.shift()
    if (!call) {
      return
    }
    const error = new OpenCodeSqliteWorkerUnavailableError('worker spawn failed')
    const shouldTrip = call.context.noteWorkerUnavailable()
    this.settle(call, () => call.reject(error))
    if (shouldTrip) {
      // Arms the process-wide backoff and terminates the scan, so end-of-scan
      // bookkeeping cannot mistake it for a clean run and clear the backoff.
      call.context.tripUnavailableCircuit(error)
      return
    }
    this.releaseContextAbortListenerIfUnused(call.context)
    if (this.queue.length > 0) {
      this.pump()
    }
  }

  private settle(call: PendingCall, run: () => void): void {
    if (call.timer) {
      clearTimeout(call.timer)
      call.timer = null
    }
    if (call.activeAtMs !== null) {
      call.context.noteActiveWorker(Date.now() - call.activeAtMs)
      call.activeAtMs = null
    }
    if (this.active === call) {
      this.active = null
    }
    run()
  }

  private ensureContextAbortListener(context: OpenCodeSqliteScanContext): void {
    if (this.contextAbortListeners.has(context)) {
      return
    }
    // `dispatch` rejects an already-terminated context before enqueueing, so the
    // signal is always live here.
    const onAbort = (): void => this.onContextAbort(context)
    this.contextAbortListeners.set(context, onAbort)
    context.signal.addEventListener('abort', onAbort, { once: true })
  }

  private onContextAbort(context: OpenCodeSqliteScanContext): void {
    const error = context.terminationError()
    if (this.active?.context === context) {
      const active = this.active
      this.handle.destroy()
      context.markWorkOmitted()
      this.settle(active, () => active.reject(error))
    }
    const retained: PendingCall[] = []
    for (const call of this.queue) {
      if (call.context === context) {
        context.markWorkOmitted()
        this.recordQueueWait(call, Date.now())
        this.settle(call, () => call.reject(error))
      } else {
        retained.push(call)
      }
    }
    this.queue = retained
    this.releaseContextAbortListener(context)
    if (!this.active && this.queue.length > 0) {
      this.pump()
    }
  }

  private releaseContextAbortListenerIfUnused(context: OpenCodeSqliteScanContext): void {
    if (this.active?.context !== context && !this.queue.some((call) => call.context === context)) {
      this.releaseContextAbortListener(context)
    }
  }

  private recordQueueWait(call: PendingCall, settledAtMs: number): void {
    if (call.queueWaitRecorded) {
      return
    }
    call.queueWaitRecorded = true
    call.context.noteQueueWait(settledAtMs - call.enqueuedAtMs)
  }

  private releaseContextAbortListener(context: OpenCodeSqliteScanContext): void {
    const listener = this.contextAbortListeners.get(context)
    if (!listener) {
      return
    }
    context.signal.removeEventListener('abort', listener)
    this.contextAbortListeners.delete(context)
  }

  private afterSettle(): void {
    if (this.queue.length > 0) {
      this.pump()
      return
    }
    // Only tear down with nothing active AND nothing queued: a request arriving
    // as the timer fires must never be lost to a self-exiting worker.
    this.handle.scheduleIdleTeardown(() => !this.active && this.queue.length === 0)
  }
}
