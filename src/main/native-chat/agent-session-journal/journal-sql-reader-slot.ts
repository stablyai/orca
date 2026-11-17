import type {
  JournalForkPreparationInput,
  JournalForkPreparationResult
} from './journal-fork-preparation'

import type { Worker } from 'node:worker_threads'

import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'

import { restoreJournalSqlFailure } from './journal-sql-failure'
import { AgentSessionJournalError } from './writing/journal-write-guards'
import {
  claimJournalReaderRecord,
  describeJournalReaderOperation,
  recordJournalReaderRequest,
  type JournalReaderRunningRequest,
  releaseJournalReaderRecord
} from './journal-sql-reader-requests'

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
      operation: JournalSqlReaderOperation
      resolve: (response: JournalSqlReaderResult) => void
      reject: (error: Error) => void
    }
  >()
  private record?: number
  private running?: { id: number; queued: number; request: JournalReaderRunningRequest }
  /** A fork or conversion reservation's later steps name the chat its first step opened. */
  private readonly reservedChats = new Map<number, string | null>()
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
      name: 'orca-journal-sql-reader',
      workerData: { filename, originalFilename },
      execArgv: []
    })
    this.record = claimJournalReaderRecord(this)
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
        this.recordRunning()
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
      this.pending.set(id, { operation, resolve, reject })
      this.recordRunning()
      void this.ready.promise
        .then(() => {
          if (this.pending.has(id)) {
            this.worker.postMessage({ id, operation } satisfies JournalSqlReaderRequest)
          }
        })
        .catch((error: unknown) => {
          this.pending.delete(id)
          this.recordRunning()
          if (this.pending.size === 0) {
            this.worker.unref()
          }
          reject(error)
        })
    })
    return { id, result }
  }

  close(): Promise<void> {
    releaseJournalReaderRecord(this)
    this.record = undefined
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
    this.recordRunning()
  }

  /** Replies are FIFO: the oldest unanswered request is running, or answered but not yet read. */
  private recordRunning(): void {
    if (this.record === undefined) {
      return
    }
    const oldest = this.pending.entries().next().value
    const queued = this.pending.size - 1
    if (oldest?.[0] === this.running?.id && queued === this.running?.queued) {
      return
    }
    if (!oldest) {
      this.running = undefined
      recordJournalReaderRequest(this.record, null)
      return
    }
    const [id, { operation }] = oldest
    const request: JournalReaderRunningRequest =
      id === this.running?.id
        ? { ...this.running.request, queued }
        : {
            ...this.describe(id, operation),
            startedAt: Date.now(),
            queued,
            threadId: this.worker.threadId
          }
    this.running = { id, queued, request }
    recordJournalReaderRequest(this.record, request)
  }

  private describe(
    id: number,
    operation: JournalSqlReaderOperation
  ): Pick<JournalReaderRunningRequest, 'operation' | 'chat'> {
    const described = describeJournalReaderOperation(operation)
    switch (operation.kind) {
      case 'fork-prepare':
      case 'conversion-prepare':
        this.reservedChats.set(id, described.chat)
        return described
      case 'fork-next':
      case 'conversion-page':
        return { ...described, chat: this.reservedChat(operation) }
      case 'fork-release':
      case 'conversion-release': {
        const chat = this.reservedChat(operation)
        this.reservedChats.delete(reservationId(operation))
        return { ...described, chat }
      }
      case 'domain-history':
      case 'database':
      case 'point':
      case 'import-state':
        return described
    }
  }

  private reservedChat(
    operation: { preparationId: number } | { conversionId: number }
  ): string | null {
    return this.reservedChats.get(reservationId(operation)) ?? null
  }
}

function reservationId(operation: { preparationId: number } | { conversionId: number }): number {
  return 'preparationId' in operation ? operation.preparationId : operation.conversionId
}
