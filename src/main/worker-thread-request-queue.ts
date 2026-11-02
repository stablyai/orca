import { LazyWorkerThreadHost, type WorkerThreadFactory } from './lazy-worker-thread-host'

/** Serialize worker calls; failures must never move their work onto the main thread. */

export type WorkerThreadRequestQueueOptions<TRequest> = {
  factory: WorkerThreadFactory
  idleTeardownMs: number
  /** Consecutive deaths after which the remaining queue is failed rather than respawned. */
  maxConsecutiveDeaths: number
  /** Omit for an unbounded queue. */
  queueCap?: { maxQueuedCalls: number; describeFull: (request: TRequest) => string }
  /** Progress messages restart the active call deadline without settling it. */
  isProgress?: (message: { id: number }) => boolean
  createUnavailableError: (message: string) => Error
  describeTimeout: (timeoutMs: number) => string
  describeExit: (code: number) => string
  describeCrashLoop: (lastError: string) => string
  /** Called only on the first spawn failure. */
  onUnavailable: (error: unknown) => void
  /** Refuse new work until the terminated worker exits; native calls can delay its exit. */
  awaitRetirement?: boolean
}

export type WorkerThreadRequestOwner = { readonly signal: AbortSignal }

type OwnerFailures = { consecutiveDeaths: number; refused: Error | null }

type PendingCall<TRequest, TResponse> = {
  request: TRequest
  timeoutMs: number
  resolve: (value: TResponse) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
  signal?: AbortSignal
  owner?: WorkerThreadRequestOwner
  cleanupAbort: () => void
}

export class WorkerThreadRequestQueue<
  TRequest extends { id: number },
  TResponse extends { id: number }
> {
  private active: PendingCall<TRequest, TResponse> | null = null
  private queue: PendingCall<TRequest, TResponse>[] = []
  private consecutiveDeaths = 0
  private readonly ownerFailures = new WeakMap<WorkerThreadRequestOwner, OwnerFailures>()
  private nextId = 1
  private disposed = false
  private readonly host: LazyWorkerThreadHost<TResponse>

  constructor(private readonly options: WorkerThreadRequestQueueOptions<TRequest>) {
    this.host = new LazyWorkerThreadHost<TResponse>({
      factory: options.factory,
      idleTeardownMs: options.idleTeardownMs,
      onMessage: (response) => this.onMessage(response),
      onError: (error) => this.onWorkerFault(error),
      onExit: (code) => this.onWorkerExit(code),
      isIdle: () => !this.active && this.queue.length === 0,
      onUnavailable: options.onUnavailable,
      awaitRetirement: options.awaitRetirement
    })
  }

  /** The timeout starts at dispatch, excluding time queued behind other requests. */
  dispatch(
    buildRequest: (id: number) => TRequest,
    timeoutMs: number,
    signal?: AbortSignal,
    owner?: WorkerThreadRequestOwner
  ): Promise<TResponse> {
    return new Promise((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('Worker request queue disposed'))
        return
      }
      if (signal?.aborted) {
        reject(signal.reason ?? new Error('Worker request aborted'))
        return
      }
      const refused = owner && this.ownerFailures.get(owner)?.refused
      if (refused) {
        reject(refused)
        return
      }
      // Build before checking capacity so a rejection can identify the dropped work.
      const request = buildRequest(this.nextId++)
      const cap = this.options.queueCap
      if (cap && this.queue.length >= cap.maxQueuedCalls) {
        reject(new Error(cap.describeFull(request)))
        return
      }
      // A new unowned burst must not inherit the previous burst's crash count.
      if (!owner && !this.active && this.queue.length === 0) {
        this.consecutiveDeaths = 0
      }
      const call: PendingCall<TRequest, TResponse> = {
        request,
        timeoutMs,
        resolve,
        reject,
        timer: null,
        signal,
        owner,
        cleanupAbort: () => signal?.removeEventListener('abort', abort)
      }
      const abort = (): void => {
        if (this.active === call) {
          this.host.destroy()
        } else {
          this.queue = this.queue.filter((queued) => queued !== call)
        }
        this.settle(call, () => reject(signal?.reason ?? new Error('Worker request aborted')))
        this.afterSettle()
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.queue.push(call)
      this.pump()
    })
  }

  dispose(): void {
    this.disposed = true
    this.host.destroy()
    const pending = this.active ? [this.active, ...this.queue] : this.queue
    this.queue = []
    for (const call of pending) {
      this.settle(call, () => call.reject(new Error('Worker request queue disposed')))
    }
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) {
      return
    }
    // A shared signal is already aborted before its remaining listeners run.
    while (this.queue[0]?.signal?.aborted) {
      const cancelled = this.queue.shift()
      if (cancelled) {
        this.settle(cancelled, () =>
          cancelled.reject(cancelled.signal?.reason ?? new Error('Worker request aborted'))
        )
      }
    }
    if (this.queue.length === 0) {
      this.host.scheduleIdleTeardown()
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
    try {
      worker.postMessage(call.request)
    } catch (error) {
      this.onWorkerFault(error instanceof Error ? error : new Error(String(error)))
    }
  }

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
    if (this.options.isProgress?.(response)) {
      this.armDeadline(call)
      return
    }
    if (call.owner) {
      this.failuresFor(call.owner).consecutiveDeaths = 0
    } else {
      this.consecutiveDeaths = 0
    }
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
    // Drop cleanly exited handles so the next call cannot post to a dead worker.
    if (code === 0 && !this.active && this.queue.length === 0) {
      this.host.destroy()
      return
    }
    this.onWorkerFault(new Error(this.options.describeExit(code)))
  }

  private onWorkerFault(error: Error): void {
    const failed = this.active
    this.host.destroy()
    if (!failed) {
      this.pump()
      return
    }
    const deaths = failed.owner
      ? ++this.failuresFor(failed.owner).consecutiveDeaths
      : ++this.consecutiveDeaths
    this.settle(failed, () => failed.reject(error))
    if (deaths >= this.options.maxConsecutiveDeaths) {
      this.drainQueueAfterCrashLoop(error, failed.owner)
      return
    }
    if (this.queue.length > 0) {
      this.pump()
    }
  }

  private drainQueueAfterCrashLoop(error: Error, owner?: WorkerThreadRequestOwner): void {
    const pending = this.queue.filter((call) => call.owner === owner)
    this.queue = this.queue.filter((call) => call.owner !== owner)
    const drainError = new Error(this.options.describeCrashLoop(error.message))
    if (owner) {
      this.failuresFor(owner).refused = drainError
    } else {
      this.consecutiveDeaths = 0
    }
    for (const call of pending) {
      this.settle(call, () => call.reject(drainError))
    }
    this.afterSettle()
  }

  private failuresFor(owner: WorkerThreadRequestOwner): OwnerFailures {
    let failures = this.ownerFailures.get(owner)
    if (!failures) {
      failures = { consecutiveDeaths: 0, refused: null }
      this.ownerFailures.set(owner, failures)
    }
    return failures
  }

  private failQueuedAsUnavailable(): void {
    const pending = this.queue
    this.queue = []
    const reason = this.host.isRetiring ? 'previous worker still exiting' : 'worker spawn failed'
    for (const call of pending) {
      this.settle(call, () => call.reject(this.options.createUnavailableError(reason)))
    }
  }

  private settle(call: PendingCall<TRequest, TResponse>, run: () => void): void {
    call.cleanupAbort()
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
