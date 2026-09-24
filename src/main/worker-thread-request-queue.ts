import { LazyWorkerThreadHost, type WorkerThreadFactory } from './lazy-worker-thread-host'

/**
 * FIFO one-at-a-time request half shared by every main-process worker-thread
 * client: per-call timeout armed at dispatch, respawn-on-fault capped so a
 * payload that reliably kills the worker cannot spin a crash loop, idle
 * teardown, and — the rule that matters — failing queued calls closed instead
 * of moving their work back onto the main thread. `LazyWorkerThreadHost` owns
 * the thread's lifetime; this owns which call a message belongs to.
 */

export type WorkerThreadRequestQueueOptions<TRequest> = {
  factory: WorkerThreadFactory
  idleTeardownMs: number
  /** Consecutive deaths after which the remaining queue is failed rather than respawned. */
  maxConsecutiveDeaths: number
  /**
   * Omit for an unbounded queue; set it where pile-up is itself the bug.
   * `describeFull` gets the rejected request so the message can name the work
   * that was dropped, which is the only detail a log has to identify it.
   */
  queueCap?: { maxQueuedCalls: number; describeFull: (request: TRequest) => string }
  /**
   * Marks a message as liveness for the active call rather than its result.
   * Omit it and `describeTimeout`'s deadline is a wall clock on the whole call;
   * supply it and the deadline becomes a no-progress window, re-armed by every
   * progress message the active call sends. Work that is slow but still moving
   * must not be killed for being slow.
   */
  isProgress?: (message: { id: number }) => boolean
  /** The client's own error subclass, so callers can tell "no worker" from a fault. */
  createUnavailableError: (message: string) => Error
  describeTimeout: (timeoutMs: number) => string
  describeExit: (code: number) => string
  describeCrashLoop: (lastError: string) => string
  /** First spawn failure only; a repeating one must not repeat the log. */
  onUnavailable: (error: unknown) => void
}

type PendingCall<TRequest, TResponse> = {
  request: TRequest
  timeoutMs: number
  resolve: (value: TResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

export class WorkerThreadRequestQueue<
  TRequest extends { id: number },
  TResponse extends { id: number }
> {
  private active: PendingCall<TRequest, TResponse> | null = null
  private queue: PendingCall<TRequest, TResponse>[] = []
  private consecutiveDeaths = 0
  private nextId = 1
  private readonly host: LazyWorkerThreadHost<TResponse>

  constructor(private readonly options: WorkerThreadRequestQueueOptions<TRequest>) {
    this.host = new LazyWorkerThreadHost<TResponse>({
      factory: options.factory,
      idleTeardownMs: options.idleTeardownMs,
      onMessage: (response) => this.onMessage(response),
      onError: (error) => this.onWorkerFault(error),
      onExit: (code) => this.onWorkerExit(code),
      isIdle: () => !this.active && this.queue.length === 0,
      onUnavailable: options.onUnavailable
    })
  }

  /**
   * Queue one request and resolve with the worker's matching response.
   * @param buildRequest - Builds the request body around the correlation id this queue stamps.
   * @param timeoutMs - Deadline measured from dispatch, not from enqueue.
   * @returns The worker's response; rejects on timeout, crash, or an unspawnable worker.
   */
  dispatch(buildRequest: (id: number) => TRequest, timeoutMs: number): Promise<TResponse> {
    return new Promise((resolve, reject) => {
      // Built before the cap check so a rejection can name the dropped work;
      // the id it burns is only a correlation token, so a gap costs nothing.
      const request = buildRequest(this.nextId++)
      const cap = this.options.queueCap
      if (cap && this.queue.length >= cap.maxQueuedCalls) {
        reject(new Error(cap.describeFull(request)))
        return
      }
      // A fresh burst from full idle starts new work: clear any death count
      // carried from a prior burst so the respawn cap can't drain it early.
      if (!this.active && this.queue.length === 0) {
        this.consecutiveDeaths = 0
      }
      this.queue.push({
        request,
        timeoutMs,
        resolve,
        reject,
        timer: null
      })
      this.pump()
    })
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) {
      return
    }
    const worker = this.host.ensure()
    if (!worker) {
      this.failQueuedAsUnavailable()
      return
    }
    const call = this.queue.shift()
    if (!call) {
      return
    }
    this.active = call
    this.host.clearIdleTimer()
    this.armDeadline(call)
    worker.postMessage(call.request)
  }

  /**
   * Clock starts at dispatch, not enqueue: a queue-inclusive deadline would fire
   * falsely on the calls waiting behind a long one. Re-armed on every progress.
   */
  private armDeadline(call: PendingCall<TRequest, TResponse>): void {
    if (call.timer) {
      clearTimeout(call.timer)
    }
    call.timer = setTimeout(() => this.onTimeout(call), call.timeoutMs)
    call.timer.unref?.()
  }

  private onMessage(response: TResponse): void {
    const call = this.active
    if (!call || call.request.id !== response.id) {
      return
    }
    // Liveness, not a result: keep waiting, but restart the no-progress window.
    if (this.options.isProgress?.(response)) {
      this.armDeadline(call)
      return
    }
    this.consecutiveDeaths = 0
    this.settle(call, () => call.resolve(response))
    this.afterSettle()
  }

  private onTimeout(call: PendingCall<TRequest, TResponse>): void {
    if (this.active !== call) {
      return
    }
    this.onWorkerFault(new Error(this.options.describeTimeout(call.timeoutMs)))
  }

  private onWorkerExit(code: number): void {
    // A clean self-exit is not a death, but the stale handle must be dropped or
    // the next dispatch would post into the dead worker and stall to timeout.
    if (code === 0 && !this.active && this.queue.length === 0) {
      this.host.destroy()
      return
    }
    this.onWorkerFault(new Error(this.options.describeExit(code)))
  }

  private onWorkerFault(error: Error): void {
    const failed = this.active
    this.host.destroy()
    this.consecutiveDeaths++
    if (failed) {
      this.settle(failed, () => failed.reject(error))
    }
    if (this.consecutiveDeaths >= this.options.maxConsecutiveDeaths) {
      this.drainQueueAfterCrashLoop(error)
      return
    }
    if (this.queue.length > 0) {
      this.pump()
    }
  }

  private drainQueueAfterCrashLoop(error: Error): void {
    const pending = this.queue
    this.queue = []
    this.consecutiveDeaths = 0
    const drainError = new Error(this.options.describeCrashLoop(error.message))
    for (const call of pending) {
      this.settle(call, () => call.reject(drainError))
    }
  }

  private failQueuedAsUnavailable(): void {
    const pending = this.queue
    this.queue = []
    for (const call of pending) {
      this.settle(call, () =>
        call.reject(this.options.createUnavailableError('worker spawn failed'))
      )
    }
  }

  private settle(call: PendingCall<TRequest, TResponse>, run: () => void): void {
    if (call.timer) {
      clearTimeout(call.timer)
      call.timer = null
    }
    if (this.active === call) {
      this.active = null
    }
    run()
  }

  private afterSettle(): void {
    if (this.queue.length > 0) {
      this.pump()
    } else {
      this.host.scheduleIdleTeardown()
    }
  }
}
