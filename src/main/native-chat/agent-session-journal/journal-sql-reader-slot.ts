import type {
  JournalForkPreparationInput,
  JournalForkPreparationResult
} from './journal-fork-preparation'

import { spawnJournalSqlReader, type JournalSqlReaderWorker } from './journal-sql-reader-spawn'

import { restoreJournalSqlFailure } from './journal-sql-failure'
import { AgentSessionJournalError } from './writing/journal-write-guards'
import {
  claimJournalReaderRecord,
  describeJournalReaderOperation,
  journalReaderThreadId,
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
    private readonly release: () => void,
    private readonly chat: string | null
  ) {}
  async next(): Promise<JournalForkPreparationResult> {
    const response = await this.slot.request(
      { kind: 'fork-next', preparationId: this.preparationId },
      this.chat
    )
    if (response.type !== 'fork-next') {
      throw new Error('fork reader returned no preparation step')
    }
    return response.result
  }
  close(): Promise<void> {
    return (this.closing ??= this.slot
      .request({ kind: 'fork-release', preparationId: this.preparationId }, this.chat)
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
    private readonly release: () => void,
    private readonly chat: string | null
  ) {}

  async next(): Promise<JournalDomainImportPage | null> {
    const response = await this.slot.request(
      { kind: 'conversion-page', conversionId: this.conversionId },
      this.chat
    )
    if (response.type !== 'rows') {
      throw new Error('journal reader returned no conversion page')
    }
    return response.page
  }

  close(): Promise<void> {
    return (this.closing ??= this.slot
      .request({ kind: 'conversion-release', conversionId: this.conversionId }, this.chat)
      .then(() => {})
      .finally(this.release))
  }
}

export class ReaderSlot {
  private readonly worker: JournalSqlReaderWorker
  private nextId = 0
  /** Ids only grow, so the oldest pending id only moves forward. */
  private oldestId = 1
  private readonly pending = new Map<
    number,
    {
      operation: JournalSqlReaderOperation
      chat?: string | null
      resolve: (response: JournalSqlReaderResult) => void
      reject: (error: Error) => void
    }
  >()
  private record?: number
  private running?: { id: number; queued: number; request: JournalReaderRunningRequest }
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
    this.worker = spawnJournalSqlReader(workerPath, { filename, originalFilename })
    this.record = claimJournalReaderRecord(this)
    const startup = setTimeout(() => {
      this.fail(new Error('journal SQL reader did not open within 10000 ms'))
      void this.close()
    }, 10000)
    void this.ready.promise.finally(() => clearTimeout(startup)).catch(() => {})
    this.worker.on('message', (reply: JournalSqlReaderReply) => {
      if (reply.type === 'ready') {
        this.ready.resolve()
        // A hosted reader that moved in-process now has a thread id.
        this.recordRunning()
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
    const operation = { kind: 'fork-prepare', input } as const
    const request = this.send(operation)
    const result = await request.result
    if (result.type !== 'fork-prepared') {
      throw new Error('fork reader returned no preparation')
    }
    const { chat } = describeJournalReaderOperation(operation)
    return new JournalSqlForkReader(this, request.id, release, chat)
  }

  async prepareConversion(sessionId: string): Promise<JournalSqlConversionReader | null> {
    this.conversions++
    const operation = { kind: 'conversion-prepare', sessionId } as const
    const request = this.send(operation)
    try {
      const response = await request.result
      if (response.type !== 'prepared') {
        throw new Error('journal reader returned no prepared conversion')
      }
      if (!response.conversion) {
        this.conversions--
        return null
      }
      const { chat } = describeJournalReaderOperation(operation)
      const release = () => {
        this.conversions--
      }
      return new JournalSqlConversionReader(response.conversion, this, request.id, release, chat)
    } catch (error) {
      this.conversions--
      throw error
    }
  }

  runsOn(workers: readonly unknown[]): boolean {
    return workers.includes(this.worker)
  }

  /** `chat` names a reservation step's chat, which its operation doesn't carry. */
  request(
    operation: JournalSqlReaderOperation,
    chat?: string | null
  ): Promise<JournalSqlReaderResult> {
    return this.send(operation, chat).result
  }

  private send(
    operation: JournalSqlReaderOperation,
    chat?: string | null
  ): {
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
      this.pending.set(id, { operation, chat, resolve, reject })
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

  // A Map's first entry walks over deleted ones, so draining a long queue that way is quadratic.
  private oldestPending() {
    while (this.oldestId <= this.nextId && !this.pending.has(this.oldestId)) {
      this.oldestId++
    }
    const pending = this.pending.get(this.oldestId)
    return pending && ([this.oldestId, pending] as const)
  }

  /** Replies are FIFO: the oldest unanswered request is running, or answered but not yet read. */
  private recordRunning(): void {
    if (this.record === undefined) {
      return
    }
    const oldest = this.oldestPending()
    const queued = this.pending.size - 1
    const threadId = journalReaderThreadId(this.worker)
    if (
      oldest?.[0] === this.running?.id &&
      queued === this.running?.queued &&
      threadId === this.running?.request.threadId
    ) {
      return
    }
    if (!oldest) {
      if (this.running) {
        this.running = undefined
        recordJournalReaderRequest(this.record, null)
      }
      return
    }
    const [id, { operation, chat }] = oldest
    let request: JournalReaderRunningRequest
    if (id === this.running?.id) {
      request = { ...this.running.request, queued, threadId }
    } else {
      const described = describeJournalReaderOperation(operation)
      request = {
        operation: described.operation,
        chat: chat === undefined ? described.chat : chat,
        startedAt: Date.now(),
        queued,
        threadId
      }
    }
    this.running = { id, queued, request }
    recordJournalReaderRequest(this.record, request)
  }
}
