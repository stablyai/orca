import type { WorkerRequestTransport, WorkerThreadFactory } from './worker-thread-transport'
export type { WorkerRequestTransport, WorkerThreadFactory } from './worker-thread-transport'

/** Clients own request state and must fail queued calls when spawning fails. */
export class LazyWorkerThreadHost<TResponse> {
  private worker: WorkerRequestTransport | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private cleanupListeners: (() => void) | null = null
  private reportedUnavailable = false
  private retiring: Promise<void> | null = null

  constructor(
    private readonly options: {
      factory: WorkerThreadFactory
      idleTeardownMs: number
      onMessage: (response: TResponse) => void
      onError: (error: Error) => void
      onExit: (code: number) => void
      /** No active or queued requests; checked again at idle expiry. */
      isIdle: () => boolean
      /** Called only for the first spawn failure. */
      onUnavailable: (error: unknown) => void
      /** Native calls can delay termination; wait for exit before spawning another worker (#24572). */
      awaitRetirement?: boolean
    }
  ) {}

  get current(): WorkerRequestTransport | null {
    return this.worker
  }

  get isRetiring(): boolean {
    return this.retiring !== null
  }

  /** Returns null if spawning fails or a previous worker is still retiring. */
  ensure(): WorkerRequestTransport | null {
    if (this.worker) {
      return this.worker
    }
    if (this.retiring) {
      return null
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
    // A rejected terminate still ends retirement, so it cannot latch spawning off.
    const exited = worker.terminate().catch(() => undefined)
    if (this.options.awaitRetirement) {
      this.retiring = exited.then(() => {
        this.retiring = null
      })
    }
  }

  scheduleIdleTeardown(): void {
    this.clearIdleTimer()
    if (!this.worker) {
      return
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      // Recheck idle state so requests arriving during the delay survive.
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
