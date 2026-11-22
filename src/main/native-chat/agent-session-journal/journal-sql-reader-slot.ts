import type { JournalForkPreparationInput } from './journal-fork-preparation'
import { JournalSqlConversionReader, JournalSqlForkReader } from './journal-sql-reader-reservations'
import { JournalReaderRunningRecord } from './journal-sql-reader-running'

import { spawnJournalSqlReader, type JournalSqlReaderWorker } from './journal-sql-reader-spawn'

import { restoreJournalSqlFailure } from './journal-sql-failure'
import { AgentSessionJournalError } from './writing/journal-write-guards'
import { waitForPromiseWithSignal } from '../../../shared/concurrency/abort-signal-reason'
import {
  claimJournalReaderRecord,
  describeJournalReaderOperation,
  journalReaderThreadId,
  releaseJournalReaderRecord
} from './journal-sql-reader-requests'

import type {
  JournalSqlReaderOperation,
  JournalSqlReaderReply,
  JournalSqlReaderRequest,
  JournalSqlReaderResult
} from './journal-sql-reader-protocol'

import {
  JournalReaderAdmission,
  journalReaderOperationAdmitted,
  type JournalReaderTicket
} from './journal-sql-reader-admission'
import type {
  JournalReaderReplyCredit,
  JournalReaderReplyCreditClaim
} from './journal-sql-reader-reply-credit'

export class ReaderSlot {
  private readonly worker: JournalSqlReaderWorker
  private nextId = 0
  private readonly pending = new Map<
    number,
    {
      operation: JournalSqlReaderOperation
      chat?: string | null
      resolve: (response: JournalSqlReaderResult, release?: () => void) => void
      reject: (error: Error) => void
    }
  >()
  private readonly running: JournalReaderRunningRecord
  failed = false
  private failure?: Error
  private conversions = 0
  private readonly ready = Promise.withResolvers<void>()
  private readonly exited = Promise.withResolvers<void>()
  private closing?: Promise<void>
  private readonly credit: JournalReaderReplyCreditClaim | undefined

  /** `unreleasedBytes`: relayed by a hosted reader, not yet released; in-process ones use credit. */
  admissionStats() {
    return { ...this.admission.stats(), unreleasedBytes: this.worker.unreleasedBytes ?? 0 }
  }

  get pendingCount(): number {
    return this.pending.size + this.conversions
  }

  constructor(
    filename: string,
    originalFilename: string,
    workerPath: string,
    private readonly admission = new JournalReaderAdmission(Infinity),
    replyCredit?: JournalReaderReplyCredit
  ) {
    this.credit = replyCredit?.claim()
    try {
      this.worker = spawnJournalSqlReader(
        workerPath,
        { filename, originalFilename },
        this.credit && { replyCredit: this.credit.grant }
      )
    } catch (error) {
      this.credit?.retire()
      throw error
    }
    this.running = new JournalReaderRunningRecord(claimJournalReaderRecord(this))
    const startup = setTimeout(() => {
      this.fail(new Error('journal SQL reader did not open within 10000 ms'))
      void this.close()
    }, 10000)
    void this.ready.promise.finally(() => clearTimeout(startup)).catch(() => {})
    // A hosted reader's release frees its relay budget; anything no caller takes frees it at once.
    this.worker.on('message', (reply: JournalSqlReaderReply, release?: () => void) => {
      if (reply.type === 'ready') {
        release?.()
        this.ready.resolve()
        // A hosted reader that moved in-process now has a thread id.
        this.recordRunning()
        if (this.pending.size === 0) {
          this.worker.unref()
        }
        return
      }
      if (reply.creditWaitExpired) {
        this.admission.creditWaitExpired()
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
        release?.()
        const error = restoreJournalSqlFailure(reply.error)
        pending?.reject(error)
        if (reply.id === undefined) {
          this.fail(error)
        }
      } else if (pending) {
        pending.resolve(reply, release)
      } else {
        release?.()
        if (reply.bytes !== undefined) {
          this.credit?.release(reply.bytes)
        }
      }
    })
    this.worker.on('error', (error) => this.fail(error))
    this.worker.once('exit', (code) => {
      if (!this.closing) {
        this.fail(new Error(`journal SQL reader exited (${code})`))
      }
      this.credit?.retire()
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
    options: { signal?: AbortSignal; chat?: string | null } = {}
  ): Promise<JournalSqlReaderResult> {
    return this.send(operation, options).result
  }

  private send(
    operation: JournalSqlReaderOperation,
    { signal, chat }: { signal?: AbortSignal; chat?: string | null } = {}
  ): { id: number; result: Promise<JournalSqlReaderResult> } {
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
    const admits = journalReaderOperationAdmitted(operation)
    // A request rejected by slot failure or close leaves the admission queue at once.
    const settled = new AbortController()
    const admissionSignal = signal ? AbortSignal.any([signal, settled.signal]) : settled.signal
    const result = new Promise<JournalSqlReaderResult>((resolve, reject) => {
      let ticket: JournalReaderTicket | undefined
      this.pending.set(id, {
        operation,
        chat,
        resolve: (reply, release) => {
          const bytes = reply.bytes ?? 0
          ticket?.received(bytes)
          resolve(reply)
          // Credit returns once the awaiting caller has taken the reply.
          queueMicrotask(() => {
            ticket?.consumed()
            release?.()
            if (reply.bytes !== undefined) {
              this.credit?.release(reply.bytes)
            }
          })
        },
        reject: (error) => {
          ticket?.consumed()
          settled.abort(error)
          reject(error)
        }
      })
      this.recordRunning()
      // A read withdrawn while its reader is still opening leaves at once.
      void waitForPromiseWithSignal(this.ready.promise, admits ? signal : undefined)
        .then(async () => {
          if (!admits || !this.pending.has(id)) {
            return
          }
          const granted = await this.admission.admit(admissionSignal)
          if (!this.pending.has(id)) {
            granted.consumed()
            return
          }
          ticket = granted
        })
        .then(() => {
          if (this.pending.has(id)) {
            this.worker.postMessage({ id, operation } satisfies JournalSqlReaderRequest)
          }
        })
        .catch((error: unknown) => {
          ticket?.consumed()
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
    this.running.release()
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

  private recordRunning(): void {
    this.running.update(this.pending, this.nextId, journalReaderThreadId(this.worker))
  }
}
