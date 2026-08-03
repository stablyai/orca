import type { Worker } from 'node:worker_threads'
import type { OpenCodeSqliteWorkerResponse } from './session-scanner-opencode-sqlite-worker-protocol'
import { errorMessage } from './session-scanner-values'

export const IDLE_TEARDOWN_MS = 30_000
// Why: OpenCode reads use synchronous node:sqlite, so `terminate()` cannot
// preempt a thread parked inside a long query — it resolves only once that query
// returns. Spawning a replacement before then stacks a second thread onto the
// same core, which is exactly the CPU burn this worker boundary exists to bound.
// So the next spawn waits during a bounded grace period; expiry is logged
// because a replacement may overlap a never-returning query.
export const TERMINATE_GRACE_MS = 5_000

export type WorkerFactory = () => Worker

/**
 * Owns the single lazily-spawned scan worker: its listeners, its idle teardown,
 * and the bounded teardown before a replacement may start. Knows nothing about
 * queueing or scan budgets.
 */
export class OpenCodeSqliteWorkerHandle {
  private worker: Worker | null = null
  private idleTimer: NodeJS.Timeout | null = null
  private teardownInFlight: Promise<void> | null = null
  private cleanupListeners: (() => void) | null = null
  private loggedUnavailable = false
  private readonly options: {
    workerFactory: WorkerFactory
    log: (message: string) => void
    onMessage: (response: OpenCodeSqliteWorkerResponse) => void
    onFault: (error: Error) => void
    onExit: (code: number) => void
    onTeardownSettled: () => void
  }

  constructor(options: OpenCodeSqliteWorkerHandle['options']) {
    this.options = options
  }

  /** True while a previous thread is within its teardown grace period. */
  get isTearingDown(): boolean {
    return this.teardownInFlight !== null
  }

  get isSpawned(): boolean {
    return this.worker !== null
  }

  ensure(): Worker | null {
    if (this.worker) {
      return this.worker
    }
    try {
      const worker = this.options.workerFactory()
      const onMessage = (response: OpenCodeSqliteWorkerResponse): void =>
        this.options.onMessage(response)
      const onError = (error: Error): void => this.options.onFault(error)
      const onExit = (code: number): void => this.options.onExit(code)
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.on('exit', onExit)
      this.cleanupListeners = () => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
      }
      // Never keep the app alive for a scan worker.
      worker.unref?.()
      this.worker = worker
      // A later spawn failure is news again once one has succeeded.
      this.loggedUnavailable = false
      return worker
    } catch (err) {
      // Why (#8864): never fall back to synchronous SQLite reads here; a missing
      // bundle or resource-exhausted spawn must omit OpenCode history rather than
      // reintroduce the main-process hang this worker boundary prevents.
      if (!this.loggedUnavailable) {
        this.loggedUnavailable = true
        this.options.log(
          `OpenCode SQLite worker unavailable; skipping its history. ${errorMessage(err)}`
        )
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
    let graceTimer: NodeJS.Timeout | null = null
    const teardown = Promise.race([
      worker.terminate().then(
        () => undefined,
        () => undefined
      ),
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(() => {
          this.options.log(
            `OpenCode SQLite worker terminate grace expired after ${TERMINATE_GRACE_MS}ms; replacement may overlap a wedged worker.`
          )
          resolve()
        }, TERMINATE_GRACE_MS)
        graceTimer.unref?.()
      })
    ]).finally(() => {
      // The loser of the race must not leave a live timer behind.
      if (graceTimer) {
        clearTimeout(graceTimer)
      }
    })
    this.teardownInFlight = teardown
    void teardown.then(() => {
      if (this.teardownInFlight !== teardown) {
        return
      }
      this.teardownInFlight = null
      this.options.onTeardownSettled()
    })
  }

  /** @param isIdle - re-checked when the timer fires; a late arrival cancels teardown. */
  scheduleIdleTeardown(isIdle: () => boolean): void {
    this.clearIdleTimer()
    if (!this.worker) {
      return
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (isIdle()) {
        this.destroy()
      }
    }, IDLE_TEARDOWN_MS)
    this.idleTimer.unref?.()
  }

  clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}
