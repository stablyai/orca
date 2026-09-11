import type { Worker } from 'node:worker_threads'

export type WorkerThreadFactory = () => Worker

/**
 * Owns the lifetime of one lazily-spawned worker thread: spawn on demand,
 * listener wiring, teardown, and idle expiry. It holds no request state, so
 * every decision about which call a message belongs to stays with its client,
 * and a failed spawn is reported rather than thrown so the client can fail its
 * queued calls closed instead of moving the work back onto the main thread.
 */
export class LazyWorkerThreadHost<TResponse> {
  private worker: Worker | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private cleanupListeners: (() => void) | null = null
  private reportedUnavailable = false

  constructor(
    private readonly options: {
      factory: WorkerThreadFactory
      idleTeardownMs: number
      onMessage: (response: TResponse) => void
      onError: (error: Error) => void
      onExit: (code: number) => void
      /** Nothing active and nothing queued, checked again when the idle timer fires. */
      isIdle: () => boolean
      /** First spawn failure only: a repeating one must not repeat the log. */
      onUnavailable: (error: unknown) => void
    }
  ) {}

  get current(): Worker | null {
    return this.worker
  }

  /** The live worker, spawning one if needed; null when no worker can be had. */
  ensure(): Worker | null {
    if (this.worker) {
      return this.worker
    }
    try {
      const worker = this.options.factory()
      const onMessage = (response: TResponse): void => this.options.onMessage(response)
      const onError = (error: Error): void => this.options.onError(error)
      const onExit = (code: number): void => this.options.onExit(code)
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.on('exit', onExit)
      this.cleanupListeners = () => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
      }
      // Never keep the app alive for background work.
      worker.unref?.()
      this.worker = worker
      return worker
    } catch (err) {
      if (!this.reportedUnavailable) {
        this.reportedUnavailable = true
        this.options.onUnavailable(err)
      }
      return null
    }
  }

  destroy(): void {
    this.clearIdleTimer()
    const worker = this.worker
    this.worker = null
    if (!worker) {
      return
    }
    this.cleanupListeners?.()
    this.cleanupListeners = null
    worker.removeAllListeners()
    void worker.terminate().catch(() => undefined)
  }

  scheduleIdleTeardown(): void {
    this.clearIdleTimer()
    if (!this.worker) {
      return
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      // Re-checked here: a request arriving as the timer fires must never be
      // lost to a self-exiting worker.
      if (this.options.isIdle()) {
        this.destroy()
      }
    }, this.options.idleTeardownMs)
    this.idleTimer.unref?.()
  }

  clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
