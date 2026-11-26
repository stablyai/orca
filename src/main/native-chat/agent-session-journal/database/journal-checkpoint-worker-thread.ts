import { setTimeout, clearTimeout } from 'node:timers'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import type { WorkerRequestTransport } from '../../../worker-threads/worker-thread-transport'
import { journalCheckpointWorkerSource } from './journal-checkpoint-worker-source'
import { JOURNAL_SIZE_LIMIT_BYTES } from './journal-database'

export const JOURNAL_CHECKPOINT_FRAMES = 1000
export const JOURNAL_CHECKPOINT_IDLE_TEARDOWN_MS = 60_000
const CHECKPOINT_RETRY_MS = 100
const CHECKPOINT_PINNED_RETRY_MS = 1000
const STOP_TIMEOUT_MS = 5000
// Saves never wait on the worker: past this, an unanswered check lets writes past the WAL ceiling.
const WORKER_STALL_MS = 5000
const RESTART_DELAY_MS = 10_000
const RESTART_MAX_DELAY_MS = 5 * 60_000

export function spawnJournalCheckpointWorker(filename: string): WorkerRequestTransport {
  return spawnWorkerThread(journalCheckpointWorkerSource, {
    name: 'orca-journal-checkpoint',
    eval: true,
    workerData: {
      filename,
      frames: JOURNAL_CHECKPOINT_FRAMES,
      retryMs: CHECKPOINT_RETRY_MS,
      pinnedRetryMs: CHECKPOINT_PINNED_RETRY_MS,
      sizeLimit: JOURNAL_SIZE_LIMIT_BYTES
    }
  })
}

/** One warning per owner: restarts and fallbacks after the first stay quiet. */
export function journalCheckpointWarning(): (error: unknown) => void {
  let warned = false
  return (error) => {
    if (warned) {
      return
    }
    warned = true
    try {
      console.warn(
        '[agent-session-journal] checkpoint worker unavailable; writer checkpoints until it restarts',
        error
      )
    } catch {
      // A diagnostic must never turn a committed write into an apparent failure.
    }
  }
}

/** Asks the thread to close its connection, terminates it after a bounded wait, and resolves only once it exited. */
export async function stopJournalCheckpointWorker(
  worker: WorkerRequestTransport,
  exited: Promise<void>
): Promise<void> {
  try {
    worker.postMessage({ type: 'stop' })
  } catch {
    // terminate below still ends it.
  }
  const timeout = setTimeout(() => {
    void worker.terminate().catch(() => {})
  }, STOP_TIMEOUT_MS)
  try {
    // Callers hand the database on once close returns, so wait for the thread itself.
    await exited
  } finally {
    clearTimeout(timeout)
  }
}

export function journalWalNeedsCheckpoint(
  log: number,
  checkpointed: number,
  oversized?: () => boolean
): boolean {
  const behind = log - checkpointed
  return behind >= JOURNAL_CHECKPOINT_FRAMES || (behind > 0 && oversized?.() === true)
}

type JournalCheckpointWorkerHooks = {
  onChecked: (ran: boolean) => void
  onStateChange: () => void
  onWarn: (error: unknown) => void
  canRetireIdle: () => boolean
  factory?: () => WorkerRequestTransport
  restartDelayMs?: number
  stallMs?: number
  idleTeardownMs?: number
}

/** Lazily spawns the off-thread checkpoint worker on backlog, retires it when idle, and restarts with backoff on crash. */
export class JournalCheckpointWorkerController {
  private worker: WorkerRequestTransport | undefined
  private retiringIdle: WorkerRequestTransport | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private spawnFailed = false
  private asking = false
  private requestId = 0
  private askedAt = 0
  private askAgain: { force: boolean } | undefined
  private exited: Promise<void> = Promise.resolve()
  /** The retiring worker's exit, kept apart: a new spawn overwrites `exited` while the old thread still closes. */
  private retiringExited: Promise<void> = Promise.resolve()
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private restartDelayMs: number
  private closing = false

  constructor(
    private readonly filename: string,
    private readonly hooks: JournalCheckpointWorkerHooks
  ) {
    this.restartDelayMs = hooks.restartDelayMs ?? RESTART_DELAY_MS
  }

  hasWorker(): boolean {
    return this.worker !== undefined
  }

  isSpawnFailed(): boolean {
    return this.spawnFailed
  }

  /** A worker inside a long checkpoint is not dead, but writes stop waiting on it, as on main. */
  stalled(): boolean {
    const stallMs = this.hooks.stallMs ?? WORKER_STALL_MS
    return this.asking && performance.now() - this.askedAt >= stallMs
  }

  /** One request at a time: a slow checkpoint never queues more behind it. */
  ask(force: boolean): void {
    this.clearIdleTimer()
    if (!this.worker) {
      if (this.closing || this.restartTimer) {
        return
      }
      this.spawn()
      if (force && this.worker) {
        this.askAgain = { force: true }
      }
      return
    }
    if (this.asking) {
      this.askAgain = { force: force || this.askAgain?.force === true }
      return
    }
    try {
      this.worker.postMessage({ type: 'check', force, id: ++this.requestId })
      this.asking = true
      this.askedAt = performance.now()
    } catch (error) {
      // A worker that can't take messages is exiting; its exit schedules the replacement.
      this.hooks.onWarn(error)
    }
  }

  spawn(): void {
    let worker: WorkerRequestTransport
    try {
      worker = this.hooks.factory?.() ?? spawnJournalCheckpointWorker(this.filename)
    } catch (error) {
      this.spawnFailed = true
      this.hooks.onWarn(error)
      this.hooks.onStateChange()
      this.scheduleRestart()
      return
    }
    this.spawnFailed = false
    this.worker = worker
    // The worker checks once at start, for a WAL a crash left behind.
    this.requestId = 0
    this.asking = true
    this.askedAt = performance.now()
    let failure: unknown
    worker.on('message', (message: { type?: unknown; id?: unknown; ran?: unknown }) => {
      if (message?.type !== 'checked' || this.worker !== worker) {
        return
      }
      const ran = message.ran === true
      if (ran) {
        this.restartDelayMs = this.hooks.restartDelayMs ?? RESTART_DELAY_MS
      }
      if (message.id === this.requestId && this.asking) {
        this.asking = false
        const again = this.askAgain
        this.askAgain = undefined
        if (again) {
          this.ask(again.force)
        } else {
          this.scheduleIdleRetire()
        }
      }
      this.hooks.onChecked(ran)
    })
    worker.on('error', (error: Error) => {
      failure = error
    })
    this.exited = new Promise<void>((resolve) => {
      worker.on('exit', (code: number) => {
        resolve()
        const retiredIdle = this.retiringIdle === worker
        if (retiredIdle) {
          this.retiringIdle = undefined
        }
        if (this.worker === worker) {
          this.worker = undefined
          this.asking = false
          this.askAgain = undefined
        }
        if (this.closing || retiredIdle) {
          return
        }
        this.spawnFailed = true
        this.hooks.onStateChange()
        this.hooks.onWarn(failure ?? new Error(`checkpoint worker exited with code ${code}`))
        this.scheduleRestart()
      })
    })
    worker.unref()
    this.hooks.onStateChange()
  }

  async close(): Promise<void> {
    this.closing = true
    this.clearIdleTimer()
    clearTimeout(this.restartTimer)
    if (this.worker) {
      await stopJournalCheckpointWorker(this.worker, this.exited)
    }
    await this.retiringExited
  }

  private scheduleIdleRetire(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      if (this.closing || !this.worker || this.asking || !this.hooks.canRetireIdle()) {
        return
      }
      const idle = this.worker
      this.retiringIdle = idle
      this.worker = undefined
      this.retiringExited = this.exited
      void stopJournalCheckpointWorker(idle, this.retiringExited)
    }, this.hooks.idleTeardownMs ?? JOURNAL_CHECKPOINT_IDLE_TEARDOWN_MS)
    this.idleTimer.unref()
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
  }

  /** Each restart that dies before a checkpoint succeeds waits twice as long, so a persistent failure settles. */
  private scheduleRestart(): void {
    if (this.closing) {
      return
    }
    clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (!this.closing) {
        this.spawn()
      }
    }, this.restartDelayMs)
    this.restartTimer.unref()
    this.restartDelayMs = Math.min(this.restartDelayMs * 2, RESTART_MAX_DELAY_MS)
  }
}
