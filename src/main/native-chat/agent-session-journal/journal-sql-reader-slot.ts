import type {
  JournalForkPreparationInput,
  JournalForkPreparationResult
} from './journal-fork-preparation'

import type { Worker } from 'node:worker_threads'

import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'

import { restoreJournalSqlFailure } from './journal-sql-failure'
import { AgentSessionJournalError } from './writing/journal-write-guards'

import type {
  JournalSqlReaderOperation,
  JournalSqlReaderReply,
  JournalSqlReaderRequest,
  JournalSqlReaderResult
} from './journal-sql-reader-protocol'

import type { JournalDomainImportHeader, JournalDomainImportPage } from './journal-domain-import'

export class JournalSqlForkReader {
  private closing?: Promise<void>
  constructor(
    private readonly slot: ReaderSlot,
    private readonly preparationId: number,
    private readonly release: () => void
  ) {}
  async next(): Promise<JournalForkPreparationResult> {
    const response = await this.slot.request({
      kind: 'fork-next',
      preparationId: this.preparationId
    })
    if (response.type !== 'fork-next') {
      throw new Error('fork reader returned no preparation step')
    }
    return response.result
  }
  close(): Promise<void> {
    return (this.closing ??= this.slot
      .request({ kind: 'fork-release', preparationId: this.preparationId })
      .then(() => {})
      .finally(this.release))
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

export class ReaderSlot {
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
      if (!this.closing) {
        this.fail(new Error(`journal SQL reader exited (${code})`))
      }
      this.exited.resolve()
    })
    // Startup can fail before a caller awaits readiness.
    void this.ready.promise.catch(() => {})
  }

  async prepareFork(
    input: JournalForkPreparationInput,
    release: () => void
  ): Promise<JournalSqlForkReader> {
    const request = this.send({ kind: 'fork-prepare', input })
    const result = await request.result
    if (result.type !== 'fork-prepared') {
      throw new Error('fork reader returned no preparation')
    }
    return new JournalSqlForkReader(this, request.id, release)
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
    if (this.closing) {
      return {
        id,
        result: Promise.reject(
          new AgentSessionJournalError('journal_closed', 'journal SQL reader is closed')
        )
      }
    }
    if (this.failed) {
      return { id, result: Promise.reject(this.failure ?? new Error('journal SQL reader failed')) }
    }
    this.worker.ref()
    const result = new Promise<JournalSqlReaderResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      void this.ready.promise
        .then(() => {
          if (this.pending.has(id)) {
            this.worker.postMessage({ id, operation } satisfies JournalSqlReaderRequest)
          }
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
    return (this.closing ??= Promise.resolve()
      .then(() => {
        const error = new AgentSessionJournalError('journal_closed', 'journal SQL reader is closed')
        this.ready.reject(error)
        this.rejectPending(error)
        return this.worker.terminate()
      })
      .then(() => this.exited.promise))
  }

  private fail(error: Error): void {
    if (this.closing) {
      return
    }
    this.failed = true
    this.failure ??= error
    this.ready.reject(error)
    this.rejectPending(error)
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }
}
