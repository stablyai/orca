import { setTimeout, clearTimeout } from 'node:timers'
import { Worker } from 'node:worker_threads'
import type Database from '../../sqlite/sync-database'
import type { WorkerRequestTransport } from '../../worker-thread-transport'
import { journalCheckpointWorkerSource } from './journal-checkpoint-worker-source'
import { JOURNAL_SIZE_LIMIT_BYTES } from './journal-database'

const HEALTH_TIMEOUT_MS = 5000

type CheckpointResponse = { type: 'checked'; id?: number }

/** Maintenance never participates in write admission or the durability acknowledgement. */
export class JournalCheckpointOwner {
  private worker: WorkerRequestTransport | undefined
  private exited: Promise<void> = Promise.resolve()
  private deadline: ReturnType<typeof setTimeout> | undefined
  private stopped = false
  private closing = false
  private pending: number | undefined
  private nextRequest = 0
  private dirty = false
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
      // Older SQLite interprets NOOP as PASSIVE, which would move maintenance back onto the host.
      if (major < 3 || (major === 3 && minor < 51)) {
        this.fallback(new Error(`SQLite ${version} lacks NOOP checkpoints`))
        return
      }
      const worker = options.factory
        ? options.factory()
        : new Worker(journalCheckpointWorkerSource, {
            eval: true,
            workerData: { filename, sizeLimit: JOURNAL_SIZE_LIMIT_BYTES }
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
      // Cover schema/setup debt even when no future write arrives.
      this.afterCommit()
    } catch (error) {
      this.fallback(error)
    }
  }

  afterCommit(): void {
    try {
      if (this.closing) {
        return
      }
      if (this.stopped) {
        this.restore()
        return
      }
      this.dirty = true
      if (this.pending !== undefined) {
        return
      }
      this.dirty = false
      this.pending = ++this.nextRequest
      this.worker?.postMessage({ type: 'check', id: this.pending })
      this.armDeadline()
    } catch (error) {
      this.fallback(error)
    }
  }

  close(): Promise<void> {
    this.closing = true
    this.clearDeadline()
    this.closePromise ??= this.finishClose().catch((error: unknown) => {
      this.closing = false
      this.fallback(error)
      this.closePromise = undefined
      throw error
    })
    return this.closePromise
  }

  private receive(message: CheckpointResponse): void {
    if (this.stopped || this.closing) {
      return
    }
    try {
      if (message.type === 'checked' && message.id === this.pending && this.pending !== undefined) {
        this.pending = undefined
        this.clearDeadline()
        if (this.dirty) {
          this.afterCommit()
        }
      }
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
    this.clearDeadline()
    this.restoreNeeded = true
    try {
      this.restore()
    } catch (restoreError) {
      this.warn(restoreError)
    }
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
    if (!this.restoreNeeded) {
      return
    }
    this.writer.pragma('wal_autocheckpoint = 1000')
    this.restoreNeeded = false
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
    this.clearDeadline()
    this.deadline = setTimeout(
      () => this.fallback(new Error('checkpoint worker response timed out')),
      this.options.timeoutMs ?? HEALTH_TIMEOUT_MS
    )
    const timer: unknown = this.deadline
    if (
      typeof timer === 'object' &&
      timer !== null &&
      'unref' in timer &&
      typeof timer.unref === 'function'
    ) {
      timer.unref()
    }
  }

  private clearDeadline(): void {
    clearTimeout(this.deadline)
    this.deadline = undefined
  }

  private async finishClose(): Promise<void> {
    const worker = this.worker
    if (worker) {
      await worker.terminate()
      await this.exited
      this.worker = undefined
    }
    this.restoreNeeded = true
    this.restore()
  }
}
