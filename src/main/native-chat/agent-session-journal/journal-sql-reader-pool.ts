import type { JournalOutlineCache } from './journal-domain-outline'
import type { Worker } from 'node:worker_threads'
import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session/agent-session-wire'
import { restoreJournalSqlFailure } from './journal-sql-failure'
import type {
  JournalSqlReaderOperation,
  JournalSqlReaderReply,
  JournalSqlReaderRequest,
  JournalSqlReaderResult
} from './journal-sql-reader-protocol'
import type { JournalDomainImportHeader, JournalDomainImportPage } from './journal-domain-import'
import type {
  JournalSqlDatabaseRead,
  JournalSqlDatabaseReadResult
} from './journal-sql-database-read'
import type { JournalSqlPointRead, JournalSqlPointReadResult } from './journal-sql-point-read'
import type { JournalDomainHistoryRequest } from './journal-domain-history-page'

/** Four WAL readers isolate slow pages; each request executes entirely on its assigned connection. */
export class JournalSqlReaderPool {
  private readonly slots: ReaderSlot[] = []
  private readonly retiring = new Set<Promise<void>>()
  private closed = false
  private closing?: Promise<void>
  private conversionSlot?: ReaderSlot

  constructor(
    private readonly filename: string,
    private readonly originalFilename: string,
    private readonly workerPath = resolveWorkerThreadEntryPath(
      currentWorkerEntryLayout(__dirname),
      'journal-sql-reader-entry.js'
    ),
    private readonly cacheOutline?: (cache: JournalOutlineCache) => void
  ) {}

  async domainHistory(request: JournalDomainHistoryRequest): Promise<AgentSessionHistoryResult> {
    const response = await this.slot().request({ kind: 'domain-history', request })
    if (response.type !== 'page') {
      throw new Error('journal reader returned no domain history page')
    }
    return response.result
  }

  async prepareConversion(sessionId: string): Promise<JournalSqlConversionReader | null> {
    if (!this.conversionSlot || this.conversionSlot.failed) {
      this.conversionSlot = this.slot()
    }
    return this.conversionSlot.prepareConversion(sessionId)
  }

  async importState(sessionId: string) {
    const response = await this.slot().request({ kind: 'import-state', sessionId })
    if (response.type !== 'import-state') {
      throw new Error('journal reader returned no import state')
    }
    return response.state
  }

  async database(operation: JournalSqlDatabaseRead): Promise<JournalSqlDatabaseReadResult> {
    const response = await this.slot().request({ kind: 'database', operation })
    if (response.type !== 'database') {
      throw new Error('journal reader returned no database result')
    }
    return response.result
  }

  async point(request: JournalSqlPointRead): Promise<JournalSqlPointReadResult> {
    const response = await this.slot().request({ kind: 'point', request })
    if (response.type !== 'point') {
      throw new Error('journal reader returned no point result')
    }
    if (response.result.kind === 'conversation-outline' && response.result.cache) {
      const { cache, ...result } = response.result
      this.cacheOutline?.(cache)
      return result
    }
    return response.result
  }

  private slot(): ReaderSlot {
    if (this.closed) {
      throw new Error('journal SQL reader pool is closed')
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
      slot = new ReaderSlot(this.filename, this.originalFilename, this.workerPath)
      this.slots.push(slot)
    }
    return slot!
  }

  close(): Promise<void> {
    this.closed = true
    return (this.closing ??= Promise.all([
      ...this.retiring,
      ...this.slots.map((slot) => slot.close())
    ]).then(() => {}))
  }
}

/** The reservation keeps pages on the worker holding this chat's restored rows. */
export class JournalSqlConversionReader {
  private closing?: Promise<void>

  constructor(
    readonly header: JournalDomainImportHeader,
    private readonly slot: ReaderSlot,
    private readonly conversionId: number,
    private readonly release: () => void
  ) {}

  async next(): Promise<JournalDomainImportPage | null> {
    const response = await this.slot.request({
      kind: 'conversion-page',
      conversionId: this.conversionId
    })
    if (response.type !== 'rows') {
      throw new Error('journal reader returned no conversion page')
    }
    return response.page
  }

  close(): Promise<void> {
    return (this.closing ??= this.slot
      .request({ kind: 'conversion-release', conversionId: this.conversionId })
      .then(() => {})
      .finally(this.release))
  }
}

class ReaderSlot {
  private readonly worker: Worker
  private nextId = 0
  private readonly pending = new Map<
    number,
    {
      resolve: (response: JournalSqlReaderResult) => void
      reject: (error: Error) => void
    }
  >()
  failed = false
  private failure?: Error
  private conversions = 0
  private readonly ready = Promise.withResolvers<void>()
  private readonly exited = Promise.withResolvers<void>()
  private closing?: Promise<void>

  get pendingCount(): number {
    return this.pending.size + this.conversions
  }

  constructor(filename: string, originalFilename: string, workerPath: string) {
    this.worker = spawnWorkerThread(workerPath, {
      workerData: { filename, originalFilename },
      execArgv: []
    })
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
      if (reply.type === 'failed') {
        const error = restoreJournalSqlFailure(reply.error)
        pending?.reject(error)
        if (reply.id === undefined) {
          this.fail(error)
        }
      } else {
        pending?.resolve(reply)
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

  async prepareConversion(sessionId: string): Promise<JournalSqlConversionReader | null> {
    this.conversions++
    const request = this.send({ kind: 'conversion-prepare', sessionId })
    try {
      const response = await request.result
      if (response.type !== 'prepared') {
        throw new Error('journal reader returned no prepared conversion')
      }
      if (!response.conversion) {
        this.conversions--
        return null
      }
      return new JournalSqlConversionReader(response.conversion, this, request.id, () => {
        this.conversions--
      })
    } catch (error) {
      this.conversions--
      throw error
    }
  }

  request(operation: JournalSqlReaderOperation): Promise<JournalSqlReaderResult> {
    return this.send(operation).result
  }

  private send(operation: JournalSqlReaderOperation): {
    id: number
    result: Promise<JournalSqlReaderResult>
  } {
    const id = ++this.nextId
    if (this.failed) {
      return { id, result: Promise.reject(this.failure ?? new Error('journal SQL reader failed')) }
    }
    this.worker.ref()
    const result = new Promise<JournalSqlReaderResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      void this.ready.promise
        .then(() => {
          this.worker.postMessage({ id, operation } satisfies JournalSqlReaderRequest)
        })
        .catch((error: unknown) => {
          this.pending.delete(id)
          if (this.pending.size === 0) {
            this.worker.unref()
          }
          reject(error)
        })
    })
    return { id, result }
  }

  close(): Promise<void> {
    return (this.closing ??= this.worker.terminate().then(() => this.exited.promise))
  }

  private fail(error: Error): void {
    this.failed = true
    this.failure ??= error
    this.ready.reject(error)
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}
