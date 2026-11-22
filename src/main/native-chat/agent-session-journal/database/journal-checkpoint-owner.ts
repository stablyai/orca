import type Database from '../../../sqlite/sync-database'
import { JournalWalWaiters, journalWalGated } from './journal-wal-admission'
import type { JournalCheckpointOutage } from './journal-checkpoint-outages'
import type { CheckpointResponse } from './journal-checkpoint-worker-source'
import {
  JournalCheckpointWorkerSupervisor,
  type JournalCheckpointWorkerOptions
} from './journal-checkpoint-worker-supervisor'

/** One writer observes outside transactions; the checkpoint thread never races an admitted truncate. */
export class JournalCheckpointOwner {
  private readonly worker: JournalCheckpointWorkerSupervisor<CheckpointResponse>
  /** The writer checkpoints for itself: no worker yet, or one that hasn't answered since it lost them. */
  private stopped = true
  private closing = false
  private attachOwed = false
  private pending: number | undefined
  private nextRequest = 0
  private generation = 0
  private attachedGeneration = 0
  private checkAgain = false
  /** WAL frames since the last reset; the writer reports it beside each commit. */
  log = 0
  private checkpointed = 0
  private frames: ReturnType<Database.Database['prepare']> | undefined
  private unknown = true
  private blocked = false
  private truncate: { id: number; acknowledged: boolean } | undefined
  private readonly waiters = new JournalWalWaiters()
  private restoreNeeded = false
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly writer: Database.Database,
    filename: string,
    options: JournalCheckpointWorkerOptions = {}
  ) {
    this.worker = new JournalCheckpointWorkerSupervisor(
      filename,
      {
        receive: (message) => this.receive(message),
        lose: (error, cause) => this.lose(error, cause),
        late: (stuck) => this.late(stuck),
        drained: () => this.wake()
      },
      options
    )
    try {
      const version = String(writer.prepare('SELECT sqlite_version() AS version').get()?.version)
      const [major = 0, minor = 0] = version.split('.').map(Number)
      if (major < 3 || (major === 3 && minor < 51)) {
        throw new Error(`SQLite ${version} lacks NOOP checkpoints`)
      }
      this.frames = writer.prepare('PRAGMA wal_checkpoint(NOOP)')
    } catch (error) {
      this.worker.disable()
      this.lose(error, 'spawn')
      return
    }
    this.worker.start()
    // The first worker takes checkpoints at once, so a WAL left by a crash isn't checkpointed on the
    // writer; a replacement takes them only once it answers.
    if (this.worker.running) {
      this.attach()
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
        this.request()
        this.wake()
      })
    }
  }

  admits(urgent: boolean): boolean {
    return !this.gated(urgent)
  }

  /** Also called in finally after rollback or partially successful autocommit maintenance. */
  afterCommit(): void {
    if (this.attachOwed && !this.closing && !this.writer.isTransaction) {
      this.attach()
      return
    }
    if (this.closing || this.writer.isTransaction) {
      return
    }
    if (this.stopped) {
      this.worker.wanted()
      return
    }
    try {
      this.generation++
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
      this.request()
      this.wake()
    } catch (error) {
      this.lose(error, 'error')
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.finishClose().catch((error: unknown) => {
      this.closePromise = undefined
      throw error
    })
    return this.closePromise
  }

  private gated(urgent = false): boolean {
    if (this.worker.draining) {
      return true
    }
    const { stopped, unknown, blocked, log } = this
    return journalWalGated({ stopped, unknown, blocked, log, truncating: !!this.truncate }, urgent)
  }

  private wake(): void {
    this.waiters.wake((urgent) => this.gated(urgent))
  }

  /** Takes checkpoints from the writer; a write transaction defers it to its afterCommit. */
  private attach(): void {
    if (this.writer.isTransaction) {
      this.attachOwed = true
      return
    }
    this.attachOwed = false
    this.stopped = false
    this.unknown = true
    this.blocked = false
    this.truncate = undefined
    this.pending = undefined
    this.checkAgain = false
    try {
      this.restoreNeeded = true
      this.writer.pragma('wal_autocheckpoint = 0')
      this.afterCommit()
      this.attachedGeneration = this.generation
    } catch (error) {
      this.lose(error, 'error')
    }
  }

  private request(): void {
    if (this.stopped || this.writer.isTransaction) {
      return
    }
    if (this.truncate) {
      this.acknowledge()
      return
    }
    if (this.pending !== undefined) {
      this.checkAgain = true
      return
    }
    if (!this.gated() && this.log - this.checkpointed < 1000) {
      return
    }
    this.pending = ++this.nextRequest
    this.worker.post({
      type: 'check',
      id: this.pending,
      generation: this.generation,
      force: this.gated()
    })
  }

  private acknowledge(): void {
    if (!this.truncate || this.truncate.acknowledged || this.writer.isTransaction || this.stopped) {
      return
    }
    this.truncate.acknowledged = true
    this.worker.grantTruncate()
    this.worker.post({ type: 'truncate', truncateId: this.truncate.id })
  }

  private receive(message: CheckpointResponse): void {
    if (this.closing) {
      return
    }
    if (this.stopped) {
      // A starting or late worker answered: it takes checkpoints with fresh state.
      this.worker.unwatch()
      this.attach()
      if (this.stopped) {
        return
      }
    }
    // Also ends a stuck truncate's outage, which never handed checkpoints back.
    this.worker.recovered()
    try {
      if (message.type === 'truncate-request' && Number.isSafeInteger(message.truncateId)) {
        // Measured before the worker last took checkpoints over, while the writer had them: it would
        // truncate a WAL it never saw, so the worker skips it, and a fresh check follows if writes wait.
        if (message.generation < this.attachedGeneration) {
          this.worker.post({ type: 'truncate', truncateId: message.truncateId })
          this.request()
          return
        }
        this.truncate = { id: message.truncateId!, acknowledged: false }
        this.blocked = true
        this.acknowledge()
        return
      }
      if (message.type === 'checked') {
        this.checked(message)
      }
      // The first worker's hello can arrive after it took checkpoints; it ends that deadline too.
      if (this.pending === undefined && this.truncate === undefined) {
        this.worker.unwatch()
        if (this.checkAgain) {
          this.checkAgain = false
          this.request()
        }
        // Parked writes now wait on the worker's own retries, so a silent worker must still be caught.
        if (!this.worker.watching && this.gated()) {
          this.worker.watch()
        }
      }
      this.wake()
    } catch (error) {
      this.lose(error, 'error')
    }
  }

  private checked(message: CheckpointResponse): void {
    const completedTruncate =
      this.truncate?.acknowledged === true && message.truncateId === this.truncate.id
    if (completedTruncate) {
      this.truncate = undefined
    }
    if (
      (completedTruncate || message.generation === this.generation) &&
      Number.isSafeInteger(message.log) &&
      Number.isSafeInteger(message.checkpointed) &&
      typeof message.blocked === 'boolean'
    ) {
      this.log = message.log
      this.checkpointed = message.checkpointed
      this.blocked = message.blocked
      this.unknown = false
    }
    // A stale response retires its request without clearing newer pressure.
    if (message.id === this.pending && this.pending !== undefined) {
      this.pending = undefined
    }
  }

  /** The worker is retired; the writer checkpoints for itself until a replacement answers. */
  private lose(error: unknown, cause: JournalCheckpointOutage['cause']): void {
    if (this.closing) {
      return
    }
    this.release()
    this.worker.fail(error, cause)
    this.wake()
  }

  /**
   * A busy worker keeps its checkpoints while nothing waits on it. Once a request or parked write waits
   * on it, the writer takes them back until it answers. A truncate it is inside keeps them, since SQLite
   * holds the write lock for that whole call; one it hasn't started is revoked.
   */
  private late(stuck: boolean): boolean {
    if (this.stopped) {
      return false
    }
    if (this.truncate?.acknowledged) {
      if (this.worker.revokeTruncate()) {
        return true
      }
    } else if (!stuck && this.pending === undefined && !this.gated()) {
      return false
    }
    this.release()
    this.wake()
    return false
  }

  private release(): void {
    this.stopped = true
    this.attachOwed = false
    this.truncate = undefined
    this.pending = undefined
    this.checkAgain = false
    this.restoreNeeded = true
    try {
      this.restore()
    } catch (restoreError) {
      this.worker.warn(restoreError)
    }
  }

  private restore(): void {
    if (this.restoreNeeded) {
      this.writer.pragma('wal_autocheckpoint = 1000')
      this.restoreNeeded = false
    }
  }

  private async finishClose(): Promise<void> {
    this.closing = true
    this.stopped = true
    this.truncate = undefined
    // Timers stop first, so no restart or deadline lands while admission is handed back.
    const retired = this.worker.close()
    retired.catch(() => undefined)
    this.restoreNeeded = true
    try {
      // Hand admission back before termination: close can arrive while the drain is waiting.
      this.restore()
    } finally {
      this.wake()
    }
    await retired
  }
}
