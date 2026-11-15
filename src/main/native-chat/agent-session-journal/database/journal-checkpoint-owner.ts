import { setTimeout, clearTimeout } from 'node:timers'
import { spawnWorkerThread } from '../../../worker-threads/worker-thread-spawn'
import type Database from '../../../sqlite/sync-database'
import type { WorkerRequestTransport } from '../../../worker-threads/worker-thread-transport'
import { journalCheckpointWorkerSource } from './journal-checkpoint-worker-source'
import { JOURNAL_SIZE_LIMIT_BYTES } from './journal-database'

const HEALTH_TIMEOUT_MS = 5000
export const JOURNAL_WAL_BACKPRESSURE_FRAMES = 32_768

type CheckpointResponse = {
  type: 'checked' | 'truncate-request'
  id?: number
  generation: number
  truncateId?: number
  log: number
  checkpointed: number
  blocked: boolean
}

/** One writer observes outside transactions; the checkpoint thread never races an admitted truncate. */
export class JournalCheckpointOwner {
  private worker: WorkerRequestTransport | undefined
  private exited: Promise<void> = Promise.resolve()
  private deadline: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private closing = false
  private pending: number | undefined
  private nextRequest = 0
  private generation = 0
  private checkAgain = false
  private log = 0
  private checkpointed = 0
  private frames: ReturnType<Database.Database['prepare']> | undefined
  private unknown = true
  private blocked = false
  private truncate: { id: number; acknowledged: boolean } | undefined
  private readonly waiters = new Set<() => void>()
  private restoreNeeded = false
  private warned = false
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly writer: Database.Database,
    filename: string,
    private readonly options: {
      factory?: () => WorkerRequestTransport
      timeoutMs?: number
    } = {}
  ) {
    try {
      const version = String(writer.prepare('SELECT sqlite_version() AS version').get()?.version)
      const [major = 0, minor = 0] = version.split('.').map(Number)
      if (major < 3 || (major === 3 && minor < 51)) {
        this.fallback(new Error(`SQLite ${version} lacks NOOP checkpoints`))
        return
      }
      this.frames = writer.prepare('PRAGMA wal_checkpoint(NOOP)')
      const worker = options.factory
        ? options.factory()
        : spawnWorkerThread(journalCheckpointWorkerSource, {
            eval: true,
            workerData: {
              filename,
              sizeLimit: JOURNAL_SIZE_LIMIT_BYTES,
              backpressureFrames: JOURNAL_WAL_BACKPRESSURE_FRAMES
            }
          })
      this.worker = worker
      this.exited = new Promise((resolve) => {
        worker.on('exit', () => {
          resolve()
          if (!this.closing) {
            this.fallback(new Error('checkpoint worker exited'))
          }
        })
      })
      worker.on('message', (message: CheckpointResponse) => this.receive(message))
      worker.on('error', (error: Error) => this.fallback(error))
      worker.unref()
      this.restoreNeeded = true
      this.writer.pragma('wal_autocheckpoint = 0')
      this.afterCommit()
    } catch (error) {
      this.fallback(error)
    }
  }

  /** Only the serialized writer calls this, before its outer transaction. */
  async beforeWrite(): Promise<void> {
    if (this.writer.isTransaction) {
      throw new Error('journal WAL admission requires a transaction-free writer')
    }
    while (this.gated()) {
      await new Promise<void>((resolve) => {
        this.waiters.add(resolve)
        this.request()
        this.wake()
      })
    }
  }

  /** Also called in finally after rollback or partially successful autocommit maintenance. */
  afterCommit(): void {
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
      this.fallback(error)
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.finishClose().catch((error: unknown) => {
      this.closePromise = undefined
      throw error
    })
    return this.closePromise
  }

  private gated(): boolean {
    return (
      !this.stopped &&
      (this.unknown ||
        this.blocked ||
        this.truncate !== undefined ||
        this.log >= JOURNAL_WAL_BACKPRESSURE_FRAMES)
    )
  }

  private wake(): void {
    if (this.gated()) {
      return
    }
    const waiters = [...this.waiters]
    this.waiters.clear()
    for (const resume of waiters) {
      resume()
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
    this.send({ type: 'check', id: this.pending, generation: this.generation, force: this.gated() })
    this.armDeadline()
  }

  private acknowledge(): void {
    if (!this.truncate || this.truncate.acknowledged || this.writer.isTransaction || this.stopped) {
      return
    }
    this.truncate.acknowledged = true
    this.send({ type: 'truncate', truncateId: this.truncate.id })
    this.armDeadline()
  }

  private send(message: unknown): void {
    try {
      this.worker?.postMessage(message)
    } catch (error) {
      this.fallback(error)
    }
  }

  private receive(message: CheckpointResponse): void {
    if (this.stopped || this.closing) {
      return
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
      }
      this.wake()
    } catch (error) {
      this.fallback(error)
    }
  }

  private fallback(error: unknown): void {
    if (this.closing) {
      return
    }
    const first = !this.stopped
    this.stopped = true
    this.truncate = undefined
    this.clearDeadline()
    this.restoreNeeded = true
    try {
      this.restore()
    } catch (restoreError) {
      this.warn(restoreError)
    }
    this.wake()
    this.warn(error)
    if (first) {
      try {
        void this.worker?.terminate().catch((cause: unknown) => this.warn(cause))
      } catch (cause) {
        this.warn(cause)
      }
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

  private armDeadline(): void {
    if (this.stopped) {
      return
    }
    this.clearDeadline()
    this.deadline = setTimeout(
      () => this.fallback(new Error('checkpoint worker response timed out')),
      this.options.timeoutMs ?? HEALTH_TIMEOUT_MS
    )
    this.deadline.unref()
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
    this.restoreNeeded = true
    try {
      // Hand admission back before termination: close can arrive while the drain is waiting.
      this.restore()
    } finally {
      this.wake()
    }
    const worker = this.worker
    if (worker) {
      await worker.terminate()
      await this.exited
      this.worker = undefined
    }
  }
}
