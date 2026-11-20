import { setTimeout, clearTimeout } from 'node:timers'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import type Database from '../../../sqlite/sync-database'
import type { WorkerRequestTransport } from '../../../worker-threads/worker-thread-transport'
import {
  JOURNAL_CHECKPOINT_IN_CALL,
  JOURNAL_CHECKPOINT_REPLIES,
  journalCheckpointWorkerSource
} from './journal-checkpoint-worker-source'
import { JOURNAL_SIZE_LIMIT_BYTES } from './journal-database'
import {
  JOURNAL_WAL_BACKPRESSURE_FRAMES,
  JournalWalWaiters,
  journalWalGated
} from './journal-wal-admission'

const HEALTH_TIMEOUT_MS = 5000
const RESTART_BASE_MS = 1000
// Also how long a restarted worker must stay up before its backoff starts over.
const RESTART_MAX_MS = 60_000

type CheckpointResponse = {
  type: 'checked' | 'truncate-request'
  id?: number
  generation: number
  truncateId?: number
  log: number
  checkpointed: number
  blocked: boolean
}

export type JournalCheckpointWorkerData = {
  filename: string
  sizeLimit: number
  backpressureFrames: number
  liveness: SharedArrayBuffer
}

/** One stretch in which the writer checkpointed for itself; totals cover this launch. */
export type JournalCheckpointOutage = {
  cause: 'exited' | 'error' | 'unresponsive' | 'slow' | 'spawn'
  outageMs: number
  recovered: boolean
  restarts: number
  totalOutageMs: number
}

type Attached = {
  worker: WorkerRequestTransport
  liveness: Int32Array
  exited: Promise<void>
  spawnedAt: number
  replies: number
}

/** One writer observes outside transactions; the checkpoint thread never races an admitted truncate. */
export class JournalCheckpointOwner {
  private current: Attached | undefined
  private retiring: Promise<void> = Promise.resolve()
  private deadline: ReturnType<typeof setTimeout> | undefined
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private closing = false
  private permanent = false
  private slow = false
  private attachOwed = false
  private pending: number | undefined
  private nextRequest = 0
  private generation = 0
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
  private warned = false
  private closePromise: Promise<void> | undefined
  private outage: { since: number; cause: JournalCheckpointOutage['cause'] } | undefined
  private restarts = 0
  private totalOutageMs = 0
  private failedStarts = 0
  private readonly now: () => number

  constructor(
    private readonly writer: Database.Database,
    private readonly filename: string,
    private readonly options: {
      factory?: (workerData: JournalCheckpointWorkerData) => WorkerRequestTransport
      timeoutMs?: number
      restartBaseMs?: number
      onOutage?: (outage: JournalCheckpointOutage) => void
      now?: () => number
    } = {}
  ) {
    this.now = options.now ?? Date.now
    try {
      const version = String(writer.prepare('SELECT sqlite_version() AS version').get()?.version)
      const [major = 0, minor = 0] = version.split('.').map(Number)
      if (major < 3 || (major === 3 && minor < 51)) {
        this.permanent = true
        this.lose(new Error(`SQLite ${version} lacks NOOP checkpoints`), 'spawn')
        return
      }
      this.frames = writer.prepare('PRAGMA wal_checkpoint(NOOP)')
    } catch (error) {
      this.permanent = true
      this.lose(error, 'spawn')
      return
    }
    this.spawn()
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
    if (this.stopped || this.closing || this.writer.isTransaction) {
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
    const { stopped, unknown, blocked, log } = this
    return journalWalGated({ stopped, unknown, blocked, log, truncating: !!this.truncate }, urgent)
  }

  private wake(): void {
    this.waiters.wake((urgent) => this.gated(urgent))
  }

  private spawn(): void {
    if (this.closing) {
      return
    }
    const liveness = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT)
    const word = new Int32Array(liveness)
    // Starting counts as inside a call: a thread still booting under memory pressure isn't dead.
    Atomics.store(word, JOURNAL_CHECKPOINT_IN_CALL, 1)
    const workerData: JournalCheckpointWorkerData = {
      filename: this.filename,
      sizeLimit: JOURNAL_SIZE_LIMIT_BYTES,
      backpressureFrames: JOURNAL_WAL_BACKPRESSURE_FRAMES,
      liveness
    }
    let worker: WorkerRequestTransport
    try {
      worker = this.options.factory
        ? this.options.factory(workerData)
        : spawnWorkerThread(journalCheckpointWorkerSource, {
            name: 'orca-journal-checkpoint',
            eval: true,
            workerData
          })
    } catch (error) {
      this.lose(error, 'spawn')
      return
    }
    const attached: Attached = {
      worker,
      liveness: word,
      spawnedAt: this.now(),
      replies: 0,
      exited: new Promise((resolve) => {
        worker.on('exit', () => {
          resolve()
          if (this.current === attached) {
            this.lose(new Error('checkpoint worker exited'), 'exited')
          }
        })
      })
    }
    this.current = attached
    worker.on('message', (message: CheckpointResponse) => {
      if (this.current === attached) {
        this.receive(message)
      }
    })
    worker.on('error', (error: Error) => {
      if (this.current === attached) {
        this.lose(error, 'error')
      }
    })
    worker.unref()
    this.attach()
  }

  /** Takes checkpoints from the writer; a write transaction defers it to its afterCommit. */
  private attach(): void {
    if (this.writer.isTransaction) {
      this.attachOwed = true
      return
    }
    this.attachOwed = false
    this.stopped = false
    this.slow = false
    this.unknown = true
    this.blocked = false
    this.truncate = undefined
    this.pending = undefined
    this.checkAgain = false
    try {
      this.restoreNeeded = true
      this.writer.pragma('wal_autocheckpoint = 0')
      this.afterCommit()
      // A reply proves the worker healthy, even when the WAL needs nothing yet.
      if (this.pending === undefined && this.truncate === undefined && !this.stopped) {
        this.check()
      }
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
    this.check()
  }

  private check(): void {
    this.pending = ++this.nextRequest
    const replies = this.replies()
    this.send({ type: 'check', id: this.pending, generation: this.generation, force: this.gated() })
    this.armDeadline(false, replies)
  }

  private acknowledge(): void {
    if (!this.truncate || this.truncate.acknowledged || this.writer.isTransaction || this.stopped) {
      return
    }
    this.truncate.acknowledged = true
    const replies = this.replies()
    this.send({ type: 'truncate', truncateId: this.truncate.id })
    this.armDeadline(false, replies)
  }

  private send(message: unknown): void {
    try {
      this.current?.worker.postMessage(message)
    } catch (error) {
      this.lose(error, 'error')
    }
  }

  private receive(message: CheckpointResponse): void {
    if (this.closing) {
      return
    }
    if (this.stopped) {
      if (!this.slow) {
        return
      }
      // A slow worker answered: it takes checkpoints back with fresh state, then this reply is read
      // as any other, so a truncate it asks for is still acknowledged.
      this.attach()
      if (this.stopped) {
        return
      }
      this.recovered()
    }
    try {
      if (message.type === 'truncate-request' && Number.isSafeInteger(message.truncateId)) {
        this.truncate = { id: message.truncateId!, acknowledged: false }
        this.blocked = true
        this.acknowledge()
        return
      }
      if (message.type !== 'checked') {
        return
      }
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
        this.recovered()
      }
      // A stale response retires its request without clearing newer pressure.
      if (message.id === this.pending && this.pending !== undefined) {
        this.pending = undefined
      }
      if (this.pending === undefined && this.truncate === undefined) {
        this.clearDeadline()
        if (this.checkAgain) {
          this.checkAgain = false
          this.request()
        }
        // Parked writes now wait on the worker's own retries, so a silent worker must still be caught.
        if (this.deadline === undefined && this.gated()) {
          this.armDeadline()
        }
      }
      this.wake()
    } catch (error) {
      this.lose(error, 'error')
    }
  }

  /** The writer checkpoints for itself until a worker answers again; a slow one is kept. */
  private lose(error: unknown, cause: JournalCheckpointOutage['cause']): void {
    if (this.closing) {
      return
    }
    this.stopped = true
    this.slow = cause === 'slow'
    this.attachOwed = false
    this.truncate = undefined
    this.pending = undefined
    this.checkAgain = false
    this.clearDeadline()
    this.restoreNeeded = true
    try {
      this.restore()
    } catch (restoreError) {
      this.warn(restoreError)
    }
    this.wake()
    if (!this.outage && !this.permanent) {
      this.outage = { since: this.now(), cause }
    }
    this.warn(error)
    if (cause === 'slow') {
      this.armDeadline(true)
      return
    }
    const attached = this.current
    this.current = undefined
    if (attached) {
      this.failedStarts = this.now() - attached.spawnedAt >= RESTART_MAX_MS ? 0 : this.failedStarts
      // Terminating can't stop a native call; the next worker starts only after this one exits.
      this.retiring = attached.exited
      try {
        void attached.worker.terminate().catch((cause: unknown) => this.warn(cause))
      } catch (terminateError) {
        this.warn(terminateError)
      }
    }
    this.scheduleRestart()
  }

  private scheduleRestart(): void {
    if (this.permanent || this.closing || this.restartTimer) {
      return
    }
    const base = this.options.restartBaseMs ?? RESTART_BASE_MS
    const delay = Math.min(base * 2 ** this.failedStarts, RESTART_MAX_MS)
    this.failedStarts++
    const retiring = this.retiring
    this.restartTimer = setTimeout(() => {
      void retiring.then(() => {
        this.restartTimer = undefined
        if (!this.closing && !this.current) {
          this.restarts++
          this.spawn()
        }
      })
    }, delay)
    this.restartTimer.unref()
  }

  private recovered(): void {
    const outage = this.outage
    if (!outage) {
      return
    }
    this.outage = undefined
    this.warned = false
    this.report(outage, true)
  }

  private report(
    outage: { since: number; cause: JournalCheckpointOutage['cause'] },
    recovered: boolean
  ): void {
    const outageMs = Math.max(0, this.now() - outage.since)
    this.totalOutageMs += outageMs
    try {
      this.options.onOutage?.({
        cause: outage.cause,
        outageMs,
        recovered,
        restarts: this.restarts,
        totalOutageMs: this.totalOutageMs
      })
    } catch {
      // Telemetry never affects checkpoints.
    }
  }

  private restore(): void {
    if (this.restoreNeeded) {
      this.writer.pragma('wal_autocheckpoint = 1000')
      this.restoreNeeded = false
    }
  }

  private warn(error: unknown): void {
    if (this.warned) {
      return
    }
    this.warned = true
    try {
      console.warn(
        '[agent-session-journal] checkpoint worker unavailable; writer checkpoints',
        error
      )
    } catch {
      // A diagnostic must never turn a committed write into an apparent failure.
    }
  }

  private replies(): number {
    return this.current ? Atomics.load(this.current.liveness, JOURNAL_CHECKPOINT_REPLIES) : 0
  }

  /** `replies` is the count before the request was posted, so a reply still in flight reads as alive. */
  private armDeadline(force = false, replies = this.replies()): void {
    if (this.stopped && !force) {
      return
    }
    this.clearDeadline()
    if (this.current) {
      this.current.replies = replies
    }
    this.deadline = setTimeout(() => this.expired(), this.options.timeoutMs ?? HEALTH_TIMEOUT_MS)
    this.deadline.unref()
  }

  /** Under paging a checkpoint's fsync can outlast the deadline: only an idle, silent worker is dead. */
  private expired(): void {
    this.deadline = undefined
    const attached = this.current
    if (!attached) {
      return
    }
    const inCall = Atomics.load(attached.liveness, JOURNAL_CHECKPOINT_IN_CALL) === 1
    const replied = Atomics.load(attached.liveness, JOURNAL_CHECKPOINT_REPLIES) !== attached.replies
    if (inCall || replied) {
      this.lose(new Error('checkpoint worker is slow to respond'), 'slow')
      return
    }
    this.lose(new Error('checkpoint worker response timed out'), 'unresponsive')
  }

  private clearDeadline(): void {
    clearTimeout(this.deadline)
    this.deadline = undefined
  }

  private async finishClose(): Promise<void> {
    this.closing = true
    this.stopped = true
    this.truncate = undefined
    this.clearDeadline()
    clearTimeout(this.restartTimer)
    this.restartTimer = undefined
    this.restoreNeeded = true
    try {
      // Hand admission back before termination: close can arrive while the drain is waiting.
      this.restore()
    } finally {
      this.wake()
    }
    if (this.outage) {
      this.report(this.outage, false)
      this.outage = undefined
    }
    const attached = this.current
    if (attached) {
      await attached.worker.terminate()
      await attached.exited
      this.current = undefined
    }
    await this.retiring
  }
}
