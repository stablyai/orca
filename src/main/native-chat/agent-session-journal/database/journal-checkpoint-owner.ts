import { setTimeout, clearTimeout } from 'node:timers'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import type Database from '../../../sqlite/sync-database'
import type { WorkerRequestTransport } from '../../../worker-threads/worker-thread-transport'
import { journalCheckpointWorkerSource } from './journal-checkpoint-worker-source'
import {
  JOURNAL_WAL_BACKPRESSURE_FRAMES,
  JournalWalWaiters,
  journalWalGated
} from './journal-wal-admission'

const CHECKPOINT_FRAMES = 1000
const CHECKPOINT_RETRY_MS = 100
const CHECKPOINT_PINNED_RETRY_MS = 1000
// SQLite's default: the writer's own commits checkpoint only while no worker runs.
const WRITER_ALONE_FRAMES = 1000
const PARKED_RECHECK_MS = 100
const RESTART_DELAY_MS = 10_000
const RESTART_MAX_DELAY_MS = 5 * 60_000
const STOP_TIMEOUT_MS = 5000

/** The writer admits and measures; a worker thread runs PASSIVE checkpoints beside it and is replaced when it dies. */
export class JournalCheckpointOwner {
  private worker: WorkerRequestTransport | undefined
  private asking = false
  private askAgain: { force: boolean } | undefined
  private exited: Promise<void> = Promise.resolve()
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private restartDelayMs: number
  private recheck: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private closing = false
  /** WAL frames since the last reset; the writer reports it beside each commit. */
  log = 0
  private checkpointed = 0
  private unknown = true
  private frames: ReturnType<Database.Database['prepare']> | undefined
  private passive: ReturnType<Database.Database['prepare']> | undefined
  private truncate: ReturnType<Database.Database['prepare']> | undefined
  private readonly waiters = new JournalWalWaiters()
  private warned = false
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly writer: Database.Database,
    private readonly filename: string,
    private readonly options: {
      factory?: () => WorkerRequestTransport
      restartDelayMs?: number
    } = {}
  ) {
    this.restartDelayMs = options.restartDelayMs ?? RESTART_DELAY_MS
    try {
      const version = String(writer.prepare('SELECT sqlite_version() AS version').get()?.version)
      const [major = 0, minor = 0] = version.split('.').map(Number)
      if (major < 3 || (major === 3 && minor < 51)) {
        // Older SQLite treats NOOP as PASSIVE, so measuring would checkpoint on the writer each commit.
        this.stopped = true
        this.warn(new Error(`SQLite ${version} lacks NOOP checkpoints`))
        return
      }
      this.frames = writer.prepare('PRAGMA wal_checkpoint(NOOP)')
      this.passive = writer.prepare('PRAGMA wal_checkpoint(PASSIVE)')
      this.truncate = writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)')
      this.measure()
      this.spawn()
    } catch (error) {
      this.stopped = true
      this.warn(error)
    }
  }

  /** Only the serialized writer calls this, before its outer transaction. */
  async beforeWrite(urgent = false): Promise<void> {
    if (this.writer.isTransaction) {
      throw new Error('journal WAL admission requires a transaction-free writer')
    }
    while (this.gated(urgent)) {
      this.relieve()
      if (!this.gated(urgent)) {
        return
      }
      await new Promise<void>((resolve) => {
        this.waiters.park(urgent, resolve)
        this.armRecheck()
      })
    }
  }

  admits(urgent: boolean): boolean {
    return !this.gated(urgent)
  }

  /** Also called in finally after rollback or partially successful autocommit maintenance. */
  afterCommit(): void {
    if (this.stopped || this.closing || this.writer.isTransaction) {
      return
    }
    this.measure()
    if (this.log - this.checkpointed >= CHECKPOINT_FRAMES) {
      this.ask(false)
    }
    this.wake()
  }

  close(): Promise<void> {
    this.closePromise ??= this.finishClose().catch((error: unknown) => {
      this.closePromise = undefined
      throw error
    })
    return this.closePromise
  }

  private gated(urgent: boolean): boolean {
    const { stopped, unknown, log } = this
    return journalWalGated({ stopped, unknown, log }, urgent)
  }

  private measure(): void {
    try {
      const state = this.frames!.get()
      if (!Number.isSafeInteger(state?.log) || !Number.isSafeInteger(state?.checkpointed)) {
        throw new Error('invalid journal WAL frame counts')
      }
      this.log = Number(state!.log)
      this.checkpointed = Number(state!.checkpointed)
      this.unknown = false
    } catch {
      this.unknown = true
    }
  }

  /**
   * Runs only while a write waits on WAL room, so the writer is idle. The worker copies the backlog;
   * without one, the writer does. A fully checkpointed WAL past the ceiling resets only through
   * TRUNCATE once overlapping readers keep the next write from restarting it, so the writer tries one
   * without waiting on readers; with nothing left to copy it only shortens the file.
   */
  private relieve(): void {
    if (this.stopped || this.writer.isTransaction) {
      return
    }
    try {
      if (this.worker) {
        this.ask(true)
      } else {
        this.passive!.get()
      }
    } catch (error) {
      this.warn(error)
    }
    this.resetIfCopied()
  }

  private resetIfCopied(): void {
    if (this.stopped || this.writer.isTransaction) {
      return
    }
    try {
      this.measure()
      if (this.log >= JOURNAL_WAL_BACKPRESSURE_FRAMES && this.checkpointed === this.log) {
        const timeout = Number(this.writer.pragma('busy_timeout', { simple: true }))
        this.writer.pragma('busy_timeout = 0')
        try {
          this.truncate!.get()
        } finally {
          this.writer.pragma(`busy_timeout = ${timeout}`)
        }
        this.measure()
      }
    } catch (error) {
      this.warn(error)
    }
  }

  private wake(): void {
    this.waiters.wake((urgent) => this.gated(urgent))
    if (this.waiters.size > 0) {
      this.armRecheck()
    }
  }

  private armRecheck(): void {
    if (this.recheck || this.stopped) {
      return
    }
    this.recheck = setTimeout(() => {
      this.recheck = undefined
      this.relieve()
      this.wake()
    }, PARKED_RECHECK_MS)
  }

  /** One request at a time: a slow checkpoint never queues more behind it. */
  private ask(force: boolean): void {
    if (!this.worker) {
      return
    }
    if (this.asking) {
      this.askAgain = { force: force || this.askAgain?.force === true }
      return
    }
    try {
      this.worker.postMessage({ type: 'check', force })
      this.asking = true
    } catch (error) {
      // A worker that can't take messages is exiting; its exit schedules the replacement.
      this.warn(error)
    }
  }

  private spawn(): void {
    let worker: WorkerRequestTransport
    try {
      worker = this.options.factory
        ? this.options.factory()
        : spawnWorkerThread(journalCheckpointWorkerSource, {
            name: 'orca-journal-checkpoint',
            eval: true,
            workerData: {
              filename: this.filename,
              frames: CHECKPOINT_FRAMES,
              retryMs: CHECKPOINT_RETRY_MS,
              pinnedRetryMs: CHECKPOINT_PINNED_RETRY_MS
            }
          })
    } catch (error) {
      this.warn(error)
      this.scheduleRestart()
      return
    }
    this.worker = worker
    // The worker checks once at start, for a WAL a crash left behind.
    this.asking = true
    let failure: unknown
    worker.on('message', (message: { type?: unknown; ran?: unknown }) => {
      if (message?.type !== 'checked' || this.worker !== worker) {
        return
      }
      this.asking = false
      if (message.ran === true) {
        this.restartDelayMs = this.options.restartDelayMs ?? RESTART_DELAY_MS
      }
      const again = this.askAgain
      this.askAgain = undefined
      if (again) {
        this.ask(again.force)
      }
      // Let a parked write in as soon as the copy it waited on lands, not at the next recheck.
      if (this.waiters.size > 0) {
        this.resetIfCopied()
        this.wake()
      }
    })
    worker.on('error', (error: Error) => {
      failure = error
    })
    this.exited = new Promise((resolve) => {
      worker.on('exit', (code: number) => {
        if (this.worker === worker) {
          this.worker = undefined
          this.asking = false
          this.askAgain = undefined
        }
        resolve()
        if (this.closing) {
          return
        }
        this.autocheckpoint(WRITER_ALONE_FRAMES)
        this.warn(failure ?? new Error(`checkpoint worker exited with code ${code}`))
        this.scheduleRestart()
      })
    })
    worker.unref()
    this.autocheckpoint(0)
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

  private autocheckpoint(frames: number): void {
    try {
      this.writer.pragma(`wal_autocheckpoint = ${frames}`)
    } catch (error) {
      this.warn(error)
    }
  }

  private warn(error: unknown): void {
    if (this.warned) {
      return
    }
    this.warned = true
    try {
      console.warn(
        '[agent-session-journal] checkpoint worker unavailable; writer checkpoints until it restarts',
        error
      )
    } catch {
      // A diagnostic must never turn a committed write into an apparent failure.
    }
  }

  private async finishClose(): Promise<void> {
    this.closing = true
    this.stopped = true
    clearTimeout(this.restartTimer)
    clearTimeout(this.recheck)
    this.recheck = undefined
    // Hand admission back first: close can arrive while a drain is parked.
    this.wake()
    const worker = this.worker
    if (!worker) {
      return
    }
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
      await this.exited
    } finally {
      clearTimeout(timeout)
    }
  }
}
