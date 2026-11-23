import { setTimeout, clearTimeout } from 'node:timers'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import type Database from '../../../sqlite/sync-database'
import type { WorkerRequestTransport } from '../../../worker-threads/worker-thread-transport'
import { journalCheckpointWorkerSource } from './journal-checkpoint-worker-source'
import { JournalWalWaiters, journalWalGated } from './journal-wal-admission'

const CHECKPOINT_FRAMES = 1000
const CHECKPOINT_IDLE_MS = 100
// If the worker falls behind or is gone, the writer's own commits checkpoint past this many frames.
const WRITER_BACKSTOP_FRAMES = 10_000
const PARKED_RECHECK_MS = 100
const RESTART_DELAY_MS = 10_000
const STOP_TIMEOUT_MS = 5000

/** The writer admits and measures; a worker thread runs PASSIVE checkpoints beside it and is replaced when it dies. */
export class JournalCheckpointOwner {
  private worker: WorkerRequestTransport | undefined
  private exited: Promise<void> = Promise.resolve()
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private recheck: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private closing = false
  /** WAL frames since the last reset; the writer reports it beside each commit. */
  log = 0
  private checkpointed = 0
  private unknown = true
  private frames: ReturnType<Database.Database['prepare']> | undefined
  private passive: ReturnType<Database.Database['prepare']> | undefined
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
      writer.pragma(`wal_autocheckpoint = ${WRITER_BACKSTOP_FRAMES}`)
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
    const { stopped, unknown, log, checkpointed } = this
    return journalWalGated({ stopped, unknown, log, checkpointed }, urgent)
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

  private wake(): void {
    this.waiters.wake((urgent) => this.gated(urgent))
    if (this.waiters.size > 0) {
      this.armRecheck()
    }
  }

  /** Parked writes never wait on the worker: without one, the idle writer checkpoints for itself. */
  private armRecheck(): void {
    if (this.recheck || this.stopped) {
      return
    }
    this.recheck = setTimeout(() => {
      this.recheck = undefined
      if (!this.stopped && !this.writer.isTransaction) {
        if (this.worker) {
          this.ask(true)
        } else {
          try {
            this.passive!.get()
          } catch (error) {
            this.warn(error)
          }
        }
        this.measure()
      }
      this.wake()
    }, PARKED_RECHECK_MS)
  }

  private ask(force: boolean): void {
    try {
      this.worker?.postMessage({ type: 'check', force })
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
              idleMs: CHECKPOINT_IDLE_MS
            }
          })
    } catch (error) {
      this.warn(error)
      return
    }
    this.worker = worker
    let ready = false
    let failure: unknown
    worker.on('message', (message: { type?: unknown }) => {
      if (message?.type === 'ready') {
        ready = true
      }
    })
    worker.on('error', (error: Error) => {
      failure = error
    })
    this.exited = new Promise((resolve) => {
      worker.on('exit', (code: number) => {
        if (this.worker === worker) {
          this.worker = undefined
        }
        resolve()
        if (this.closing) {
          return
        }
        this.warn(failure ?? new Error(`checkpoint worker exited with code ${code}`))
        // A worker that never opened the database would fail the same way again.
        if (ready) {
          this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined
            if (!this.closing) {
              this.spawn()
            }
          }, this.options.restartDelayMs ?? RESTART_DELAY_MS)
          this.restartTimer.unref()
        }
      })
    })
    worker.unref()
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
