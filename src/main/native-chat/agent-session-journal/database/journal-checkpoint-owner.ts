import { setTimeout, clearTimeout } from 'node:timers'
import type Database from '../../../sqlite/sync-database'
import type { WorkerRequestTransport } from '../../../worker-threads/worker-thread-transport'
import {
  JOURNAL_CHECKPOINT_FRAMES,
  journalCheckpointWarning,
  spawnJournalCheckpointWorker,
  stopJournalCheckpointWorker
} from './journal-checkpoint-worker-thread'
import type { JournalWalWriterRelief } from './journal-wal-writer-relief'
import {
  JOURNAL_WAL_BACKPRESSURE_FRAMES,
  JournalWalWaiters,
  journalWalGated
} from './journal-wal-admission'

// SQLite's default, for the writer's own commits while no worker is answering; off while one is.
const WRITER_ALONE_FRAMES = 1000
const PARKED_RECHECK_MS = 100
// Saves never wait on the worker: past this, an unanswered check lets writes past the WAL ceiling.
const WORKER_STALL_MS = 5000
const RESTART_DELAY_MS = 10_000
const RESTART_MAX_DELAY_MS = 5 * 60_000

/** The writer admits and measures; a worker thread runs PASSIVE checkpoints beside it and is replaced when it dies. */
export class JournalCheckpointOwner {
  private worker: WorkerRequestTransport | undefined
  private asking = false
  /** The writer's own checkpoint failed with no worker answering, e.g. on a full disk. */
  private checkpointFailed = false
  private writerCheckpoints: boolean | undefined
  private requestId = 0
  private askedAt = 0
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
  private readonly waiters = new JournalWalWaiters()
  private readonly warn = journalCheckpointWarning()
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly writer: Database.Database,
    private readonly filename: string,
    private readonly options: {
      factory?: () => WorkerRequestTransport
      restartDelayMs?: number
      stallMs?: number
      /** The SQL writer thread's own checkpoints while a write waits; without it the owner only measures. */
      relief?: JournalWalWriterRelief
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
    // In a WAL file past its size limit even a few new frames must reach disk, as on main.
    const behind = this.log - this.checkpointed
    const oversized = behind > 0 && this.options.relief?.oversized() === true
    if (behind >= JOURNAL_CHECKPOINT_FRAMES || oversized) {
      this.ask(false)
    }
    this.syncWriterCheckpoints()
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
    const { unknown, log } = this
    // A failing checkpoint opens admission, as on main: writes then reach SQLite and get its error.
    const stopped = this.stopped || this.stalled() || this.checkpointFailed
    return journalWalGated({ stopped, unknown, log }, urgent)
  }

  /** The writer checkpoints its own commits exactly while no worker is attached and answering. */
  private syncWriterCheckpoints(): void {
    const alone = !this.worker || this.stalled()
    if (this.writerCheckpoints === alone || this.closing) {
      return
    }
    try {
      this.writer.pragma(`wal_autocheckpoint = ${alone ? WRITER_ALONE_FRAMES : 0}`)
      this.writerCheckpoints = alone
    } catch (error) {
      this.warn(error)
    }
  }

  /** A worker inside a long checkpoint is not dead, but writes stop waiting on it, as on main. */
  private stalled(): boolean {
    return (
      this.asking && performance.now() - this.askedAt >= (this.options.stallMs ?? WORKER_STALL_MS)
    )
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
      } else if (this.options.relief) {
        this.options.relief.checkpoint()
        this.checkpointFailed = false
      }
    } catch (error) {
      this.checkpointFailed = !this.worker
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
      const { relief } = this.options
      if (relief && this.log >= JOURNAL_WAL_BACKPRESSURE_FRAMES && this.checkpointed === this.log) {
        relief.truncate()
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
      this.syncWriterCheckpoints()
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
      this.worker.postMessage({ type: 'check', force, id: ++this.requestId })
      this.asking = true
      this.askedAt = performance.now()
    } catch (error) {
      // A worker that can't take messages is exiting; its exit schedules the replacement.
      this.warn(error)
    }
  }

  private spawn(): void {
    let worker: WorkerRequestTransport
    try {
      worker = this.options.factory?.() ?? spawnJournalCheckpointWorker(this.filename)
    } catch (error) {
      this.warn(error)
      this.syncWriterCheckpoints()
      this.scheduleRestart()
      return
    }
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
      // An answering worker checkpoints for the writer again.
      this.checkpointFailed = false
      if (message.ran === true) {
        this.restartDelayMs = this.options.restartDelayMs ?? RESTART_DELAY_MS
      }
      if (message.id === this.requestId && this.asking) {
        this.asking = false
        const again = this.askAgain
        this.askAgain = undefined
        if (again) {
          this.ask(again.force)
        }
        this.syncWriterCheckpoints()
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
        this.syncWriterCheckpoints()
        this.warn(failure ?? new Error(`checkpoint worker exited with code ${code}`))
        this.scheduleRestart()
      })
    })
    worker.unref()
    this.syncWriterCheckpoints()
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

  private async finishClose(): Promise<void> {
    this.closing = true
    this.stopped = true
    clearTimeout(this.restartTimer)
    clearTimeout(this.recheck)
    this.recheck = undefined
    // Hand admission back first: close can arrive while a drain is parked.
    this.wake()
    if (this.worker) {
      await stopJournalCheckpointWorker(this.worker, this.exited)
    }
  }
}
