import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session/agent-session-wire'
import type { JournalSqlHistoryRequest } from './journal-sql-history-page'
import { restoreJournalSqlFailure, type JournalSqlFailure } from './journal-sql-failure'

export type JournalSqlReaderRequest = { id: number; request: JournalSqlHistoryRequest }
export type JournalSqlReaderReply =
  | { type: 'ready' }
  | { type: 'page'; id: number; result: AgentSessionHistoryResult }
  | { type: 'failed'; id?: number; error: JournalSqlFailure }

/** Four WAL readers isolate slow pages; each request executes entirely on its assigned connection. */
export class JournalSqlReaderPool {
  private readonly slots: ReaderSlot[] = []
  private readonly retiring = new Set<Promise<void>>()
  private closed = false
  private closing?: Promise<void>

  constructor(
    private readonly filename: string,
    private readonly workerPath = resolveWorkerThreadEntryPath(
      currentWorkerEntryLayout(__dirname),
      'journal-sql-reader-entry.js'
    )
  ) {}

  read(request: JournalSqlHistoryRequest): Promise<AgentSessionHistoryResult> {
    if (this.closed) {
      return Promise.reject(new Error('journal SQL reader pool is closed'))
    }
    for (let index = this.slots.length - 1; index >= 0; index--) {
      if (this.slots[index]!.failed) {
        const [failed] = this.slots.splice(index, 1)
        const closed = failed!.close().finally(() => this.retiring.delete(closed))
        this.retiring.add(closed)
      }
    }
    let slot = this.slots.toSorted((a, b) => a.pendingCount - b.pendingCount)[0]
    if ((!slot || slot.pendingCount > 0) && this.slots.length < 4) {
      slot = new ReaderSlot(this.filename, this.workerPath)
      this.slots.push(slot)
    }
    return slot!.read(request)
  }

  close(): Promise<void> {
    this.closed = true
    return (this.closing ??= Promise.all([
      ...this.retiring,
      ...this.slots.map((slot) => slot.close())
    ]).then(() => {}))
  }
}

class ReaderSlot {
  private readonly worker: Worker
  private nextId = 0
  private readonly pending = new Map<
    number,
    {
      resolve: (page: AgentSessionHistoryResult) => void
      reject: (error: Error) => void
    }
  >()
  failed = false
  private readonly ready = Promise.withResolvers<void>()
  private readonly exited = Promise.withResolvers<void>()
  private closing?: Promise<void>

  get pendingCount(): number {
    return this.pending.size
  }

  constructor(filename: string, workerPath: string) {
    this.worker = spawnWorkerThread(workerPath, { workerData: { filename }, execArgv: [] })
    const startup = setTimeout(() => {
      this.fail(new Error('journal SQL reader did not open within 10000 ms'))
      void this.close()
    }, 10000)
    void this.ready.promise.finally(() => clearTimeout(startup)).catch(() => {})
    this.worker.on('message', (reply: JournalSqlReaderReply) => {
      if (reply.type === 'ready') {
        this.ready.resolve()
        if (this.pending.size === 0) {
          this.worker.unref()
        }
        return
      }
      const pending = reply.id === undefined ? undefined : this.pending.get(reply.id)
      if (reply.id !== undefined) {
        this.pending.delete(reply.id)
      }
      if (this.pending.size === 0) {
        this.worker.unref()
      }
      if (reply.type === 'page') {
        pending?.resolve(reply.result)
      } else {
        const error = restoreJournalSqlFailure(reply.error)
        pending?.reject(error)
        if (reply.id === undefined) {
          this.fail(error)
        }
      }
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.once('exit', (code) => {
      this.fail(new Error(`journal SQL reader exited (${code})`))
      this.exited.resolve()
    })
    // Startup can fail before a caller awaits readiness.
    void this.ready.promise.catch(() => {})
  }

  read(request: JournalSqlHistoryRequest): Promise<AgentSessionHistoryResult> {
    const id = ++this.nextId
    this.worker.ref()
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      void this.ready.promise
        .then(() => {
          this.worker.postMessage({ id, request } satisfies JournalSqlReaderRequest)
        })
        .catch((error: unknown) => {
          this.pending.delete(id)
          if (this.pending.size === 0) {
            this.worker.unref()
          }
          reject(error)
        })
    })
  }

  close(): Promise<void> {
    return (this.closing ??= this.worker.terminate().then(() => this.exited.promise))
  }

  private fail(error: Error): void {
    this.failed = true
    this.ready.reject(error)
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}
