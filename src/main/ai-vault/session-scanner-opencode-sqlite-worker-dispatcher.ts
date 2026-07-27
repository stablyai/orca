import type { Worker } from 'node:worker_threads'
import type {
  OpenCodeSqliteWorkerRequest,
  OpenCodeSqliteWorkerRequestBody,
  OpenCodeSqliteWorkerResponse
} from './session-scanner-opencode-sqlite-worker-protocol'
import { errorMessage } from './session-scanner-values'

export const LIST_TIMEOUT_MS = 30_000
export const PARSE_TIMEOUT_MS = 15_000
export const IDLE_TEARDOWN_MS = 30_000
export const MAX_CONSECUTIVE_DEATHS = 3

export type WorkerFactory = () => Worker

type PendingCall = {
  request: OpenCodeSqliteWorkerRequest
  timeoutMs: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout | null
}

// Keeps unavailable-worker errors distinct from database errors and timeouts.
export class OpenCodeSqliteWorkerUnavailableError extends Error {}

export class OpenCodeSqliteWorkerDispatcher {
  private worker: Worker | null = null
  private active: PendingCall | null = null
  private queue: PendingCall[] = []
  private idleTimer: NodeJS.Timeout | null = null
  private consecutiveDeaths = 0
  private nextId = 1
  private loggedWorkerUnavailable = false
  private cleanupWorkerListeners: (() => void) | null = null

  constructor(
    private readonly workerFactory: WorkerFactory,
    private readonly log: (message: string) => void = (message) => console.warn(message)
  ) {}

  dispatch(request: OpenCodeSqliteWorkerRequestBody, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.active && this.queue.length === 0) {
        this.consecutiveDeaths = 0
      }
      const id = this.nextId++
      this.queue.push({
        request: { ...request, id } as OpenCodeSqliteWorkerRequest,
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
    const worker = this.ensureWorker()
    if (!worker) {
      this.failQueuedAsUnavailable()
      return
    }
    const call = this.queue.shift()
    if (!call) {
      return
    }
    this.active = call
    this.clearIdleTimer()
    call.timer = setTimeout(() => this.onTimeout(call), call.timeoutMs)
    call.timer.unref?.()
    worker.postMessage(call.request)
  }

  private ensureWorker(): Worker | null {
    if (this.worker) {
      return this.worker
    }
    try {
      const worker = this.workerFactory()
      const onMessage = (response: OpenCodeSqliteWorkerResponse): void => this.onMessage(response)
      const onError = (error: Error): void => this.onWorkerFault(error)
      const onExit = (code: number): void => this.onWorkerExit(code)
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.on('exit', onExit)
      this.cleanupWorkerListeners = () => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
      }
      worker.unref?.()
      this.worker = worker
      return worker
    } catch (err) {
      if (!this.loggedWorkerUnavailable) {
        this.loggedWorkerUnavailable = true
        this.log(`OpenCode SQLite worker unavailable; skipping its history. ${errorMessage(err)}`)
      }
      return null
    }
  }

  private onMessage(response: OpenCodeSqliteWorkerResponse): void {
    const call = this.active
    if (!call || call.request.id !== response.id) {
      return
    }
    this.consecutiveDeaths = 0
    if (response.ok) {
      this.settle(call, () => call.resolve(response.value))
    } else {
      this.settle(call, () => call.reject(new Error(response.error)))
    }
    this.afterSettle()
  }

  private onTimeout(call: PendingCall): void {
    if (this.active === call) {
      this.onWorkerFault(new Error(`OpenCode SQLite worker timed out after ${call.timeoutMs}ms`))
    }
  }

  private onWorkerExit(code: number): void {
    if (code === 0 && !this.active && this.queue.length === 0) {
      this.destroyWorker()
      return
    }
    this.onWorkerFault(new Error(`OpenCode SQLite worker exited with code ${code}`))
  }

  private onWorkerFault(error: Error): void {
    const failed = this.active
    this.destroyWorker()
    this.consecutiveDeaths++
    if (failed) {
      this.settle(failed, () => failed.reject(error))
    }
    if (this.consecutiveDeaths >= MAX_CONSECUTIVE_DEATHS) {
      this.drainQueueAfterCrashLoop(error)
    } else if (this.queue.length > 0) {
      this.pump()
    }
  }

  private drainQueueAfterCrashLoop(error: Error): void {
    const pending = this.queue
    this.queue = []
    this.consecutiveDeaths = 0
    const drainError = new Error(
      `OpenCode SQLite worker crashed repeatedly; skipping remaining sessions (${error.message})`
    )
    for (const call of pending) {
      this.settle(call, () => call.reject(drainError))
    }
  }

  private failQueuedAsUnavailable(): void {
    const pending = this.queue
    this.queue = []
    for (const call of pending) {
      this.settle(call, () =>
        call.reject(new OpenCodeSqliteWorkerUnavailableError('worker spawn failed'))
      )
    }
  }

  private settle(call: PendingCall, run: () => void): void {
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
      this.scheduleIdleTeardown()
    }
  }

  private scheduleIdleTeardown(): void {
    this.clearIdleTimer()
    if (this.worker) {
      this.idleTimer = setTimeout(() => this.teardownIfIdle(), IDLE_TEARDOWN_MS)
      this.idleTimer.unref?.()
    }
  }

  private teardownIfIdle(): void {
    this.idleTimer = null
    if (!this.active && this.queue.length === 0) {
      this.destroyWorker()
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private destroyWorker(): void {
    this.clearIdleTimer()
    const worker = this.worker
    this.worker = null
    if (!worker) {
      return
    }
    this.cleanupWorkerListeners?.()
    this.cleanupWorkerListeners = null
    worker.removeAllListeners()
    void worker.terminate().catch(() => undefined)
  }
}
