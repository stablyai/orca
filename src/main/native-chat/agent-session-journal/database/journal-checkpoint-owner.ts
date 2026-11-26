import { setTimeout, clearTimeout } from 'node:timers'
import type Database from '../../../sqlite/sync-database'
import type { WorkerRequestTransport } from '../../../worker-threads/worker-thread-transport'
import {
  JournalCheckpointWorkerController,
  journalCheckpointWarning,
  journalWalNeedsCheckpoint
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

/** The writer admits and measures; a worker thread runs PASSIVE checkpoints beside it and is replaced when it dies. */
export class JournalCheckpointOwner {
  private readonly workers: JournalCheckpointWorkerController
  /** The writer's own checkpoint failed with no worker answering, e.g. on a full disk. */
  private checkpointFailed = false
  /** The writer's TRUNCATE at the ceiling failed; admission stays open until the log resets. */
  private truncateFailed = false
  private writerCheckpoints: boolean | undefined
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
    filename: string,
    private readonly options: {
      factory?: () => WorkerRequestTransport
      restartDelayMs?: number
      stallMs?: number
      idleTeardownMs?: number
      /** The SQL writer thread's own checkpoints while a write waits; without it the owner only measures. */
      relief?: JournalWalWriterRelief
    } = {}
  ) {
    this.workers = new JournalCheckpointWorkerController(filename, {
      factory: options.factory,
      restartDelayMs: options.restartDelayMs,
      stallMs: options.stallMs,
      idleTeardownMs: options.idleTeardownMs,
      onWarn: this.warn,
      onStateChange: () => this.syncWriterCheckpoints(),
      canRetireIdle: () => {
        // Measuring runs a NOOP checkpoint, which an open transaction on the writer must not see.
        if (this.waiters.size > 0 || this.writer.isTransaction) {
          return false
        }
        this.measure()
        return !this.needsCheckpoint()
      },
      onChecked: () => {
        // An answering worker checkpoints for the writer again.
        this.checkpointFailed = false
        this.syncWriterCheckpoints()
        // Let a parked write in as soon as the copy it waited on lands, not at the next recheck.
        if (this.waiters.size > 0) {
          this.resetIfCopied()
          this.wake()
        }
      }
    })
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
      this.syncWriterCheckpoints()
      // Only spawn eagerly when a prior run left behind a checkpointable WAL backlog.
      if (this.needsCheckpoint()) {
        this.workers.spawn()
      }
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
    this.truncateFailed &&= this.log >= JOURNAL_WAL_BACKPRESSURE_FRAMES
    // In a WAL file past its size limit even a few new frames must reach disk, as on main.
    if (this.needsCheckpoint()) {
      this.workers.ask(false)
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
    const stopped = this.stopped || this.degraded()
    return journalWalGated({ stopped, unknown: this.unknown, log: this.log }, urgent)
  }

  /**
   * A stalled worker or a failing step the writer relies on: as on main after its deadline, admission
   * opens (writes reach SQLite and get its error) and the writer checkpoints its own commits.
   */
  private degraded(): boolean {
    const failed = this.checkpointFailed || this.truncateFailed || this.unknown
    return this.workers.stalled() || failed
  }

  /** The writer checkpoints its own commits only when off-thread checkpointing is degraded or unavailable. */
  private syncWriterCheckpoints(): void {
    const alone = this.stopped || this.workers.isSpawnFailed() || this.degraded()
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

  private needsCheckpoint(): boolean {
    return journalWalNeedsCheckpoint(
      this.log,
      this.checkpointed,
      () => this.options.relief?.oversized() === true
    )
  }

  private measure(): void {
    try {
      const state = this.frames!.get()
      if (!Number.isSafeInteger(state?.log) || !Number.isSafeInteger(state?.checkpointed)) {
        this.unknown = true
        return
      }
      // busy=-1 means SQLite returned -1,-1 when a lock blocked the read; keep the last known frames.
      if (Number(state!.log) < 0) {
        return
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
      if (this.workers.hasWorker()) {
        this.workers.ask(true)
      } else if (this.options.relief) {
        this.options.relief.checkpoint()
        this.checkpointFailed = false
      }
    } catch (error) {
      this.checkpointFailed = !this.workers.hasWorker()
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
      this.truncateFailed = true
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

  private async finishClose(): Promise<void> {
    this.closing = true
    this.stopped = true
    clearTimeout(this.recheck)
    this.recheck = undefined
    // Hand admission back first: close can arrive while a drain is parked.
    this.wake()
    await this.workers.close()
  }
}
