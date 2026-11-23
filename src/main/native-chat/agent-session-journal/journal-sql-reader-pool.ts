import type { LegacyProofCursor } from './journal-legacy-source-proof'
import type {
  JournalSqlForkReader,
  JournalSqlConversionReader
} from './journal-sql-reader-reservations'
import { ReaderSlot } from './journal-sql-reader-slot'
import { JOURNAL_SQL_READERS } from './journal-sql-reader-requests'
import type { JournalForkPreparationInput } from './journal-fork-preparation'
import { throwIfSignalAborted } from '../../../shared/concurrency/abort-signal-reason'
import type { JournalOutlineCache } from './journal-domain-outline'
import type { JournalLegacyChatComparison } from './journal-sql-reader-protocol'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import type {
  JournalSqlDatabaseRead,
  JournalSqlDatabaseReadResult
} from './journal-sql-database-read'
import type { JournalSqlPointRead, JournalSqlPointReadResult } from './journal-sql-point-read'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session/agent-session-wire'
import type {
  JournalDomainHistoryFrame,
  JournalDomainHistoryRequest,
  JournalDomainHistoryWork
} from './journal-domain-history-page'
import { JournalReaderAdmission } from './journal-sql-reader-admission'
import { JournalReaderReplyCredit } from './journal-sql-reader-reply-credit'
import {
  JournalReaderIdleRetirer,
  retireFailedJournalReaderSlots
} from './journal-sql-reader-idle-retire'
import {
  trackJournalReaderRetention,
  type JournalReaderRetention
} from './journal-sql-reader-retention'

/** Four WAL readers isolate slow pages; each request executes entirely on its assigned connection. */
export class JournalSqlReaderPool {
  private readonly slots: ReaderSlot[] = []
  private readonly retiring = new Set<Promise<void>>()
  private readonly idleRetirer = new JournalReaderIdleRetirer()
  private closed = false
  private closing?: Promise<void>
  private conversionSlot?: ReaderSlot
  private sourceLease?: AbortController
  private sourceRelease?: PromiseWithResolvers<void>
  private forkSlot?: ReaderSlot
  private forkRelease?: PromiseWithResolvers<void>
  private readonly replyCredit = new JournalReaderReplyCredit()
  /** Lifetime totals of readers already replaced, so the pool's totals never go backwards. */
  private readonly replaced = { receivedBytes: 0, consumedBytes: 0, creditWaitsExpired: 0 }

  constructor(
    private readonly filename: string,
    private readonly originalFilename: string,
    private readonly workerPath = resolveWorkerThreadEntryPath(
      currentWorkerEntryLayout(__dirname),
      'journal-sql-reader-entry.js'
    ),
    private readonly cacheOutline?: (cache: JournalOutlineCache) => void,
    private readonly assertReadable?: () => void
  ) {
    trackJournalReaderRetention(this)
  }

  retention(): JournalReaderRetention {
    const total: JournalReaderRetention = {
      inFlight: 0,
      unconsumed: 0,
      waiting: 0,
      oldestWaitMs: 0,
      ...this.replaced,
      outstandingBytes: this.replyCredit.outstandingBytes()
    }
    for (const slot of this.slots) {
      const stats = slot.admissionStats()
      total.inFlight += stats.inFlight
      total.unconsumed += stats.unconsumed
      total.waiting += stats.waiting
      total.oldestWaitMs = Math.max(total.oldestWaitMs, stats.oldestWaitMs)
      total.receivedBytes += stats.receivedBytes
      total.consumedBytes += stats.consumedBytes
      total.creditWaitsExpired += stats.creditWaitsExpired
      total.outstandingBytes += stats.unreleasedBytes
    }
    return total
  }

  async prepareFork(
    input: JournalForkPreparationInput,
    signal?: AbortSignal
  ): Promise<JournalSqlForkReader> {
    while (this.forkRelease) {
      if (this.closed) {
        throw new Error('journal reader pool is closed')
      }
      throwIfSignalAborted(signal)
      const current = this.forkRelease.promise
      await (!signal
        ? current
        : new Promise<void>((resolve, reject) => {
            const aborted = () => {
              cleanup()
              reject(signal.reason)
            }
            const cleanup = () => signal.removeEventListener('abort', aborted)
            signal.addEventListener('abort', aborted, { once: true })
            void current.then(
              () => {
                cleanup()
                resolve()
              },
              (error: unknown) => {
                cleanup()
                reject(error)
              }
            )
            if (signal.aborted) {
              aborted()
            }
          }))
    }
    throwIfSignalAborted(signal)
    const slot = this.slot(true)
    this.forkSlot = slot
    const gate = Promise.withResolvers<void>()
    this.forkRelease = gate
    const release = () => {
      if (this.forkRelease === gate) {
        this.forkSlot = undefined
        this.forkRelease = undefined
        gate.resolve()
      }
    }
    try {
      return await slot.prepareFork(input, release)
    } catch (error) {
      release()
      throw error
    }
  }

  async domainHistory(request: JournalDomainHistoryRequest): Promise<AgentSessionHistoryResult> {
    return (await this.domainHistoryFrame(request)).result
  }

  /** Aborting withdraws a read still waiting for admission. */
  async domainHistoryFrame(
    request: JournalDomainHistoryRequest,
    work?: JournalDomainHistoryWork,
    signal?: AbortSignal
  ): Promise<JournalDomainHistoryFrame> {
    const response = await this.slot().request(
      {
        kind: 'domain-history',
        request,
        ...(work ? { work } : {})
      },
      { signal }
    )
    if (response.type !== 'page') {
      throw new Error('journal reader returned no domain history page')
    }
    return {
      result: response.result,
      ...(response.work ? { work: response.work } : {}),
      ...(response.acceptedUnopened === undefined
        ? {}
        : { acceptedUnopened: response.acceptedUnopened })
    }
  }

  async prepareConversion(sessionId: string): Promise<JournalSqlConversionReader | null> {
    return (await this.conversionReader()).prepareConversion(sessionId)
  }

  /** Null when the original journal is gone. Opens the original, so it waits out a retirement. */
  async compareLegacyChat(sessionId: string): Promise<JournalLegacyChatComparison | null> {
    await this.releaseSourceLease()
    const response = await this.slot().request({ kind: 'legacy-compare', sessionId })
    if (response.type !== 'legacy-compare') {
      throw new Error('journal reader returned no legacy compare')
    }
    return response.result
  }

  async legacyProof(cursor: LegacyProofCursor) {
    const response = await (await this.conversionReader()).request({ kind: 'legacy-proof', cursor })
    if (response.type !== 'legacy-proof') {
      throw new Error('legacy proof reader returned no page')
    }
    return response.page
  }

  /** Conversions and the proof open the original, so they wait out a retirement's lease. */
  private async conversionReader(): Promise<ReaderSlot> {
    await this.releaseSourceLease()
    if (!this.conversionSlot || this.conversionSlot.failed) {
      this.conversionSlot = this.slot()
    }
    return this.conversionSlot
  }

  async recycleSourceReaders(): Promise<AbortController | null> {
    if (
      this.closed ||
      this.sourceLease ||
      this.forkSlot ||
      this.slots.some((slot) => slot.pendingCount !== 0)
    ) {
      return null
    }
    const lease = new AbortController()
    this.sourceLease = lease
    this.sourceRelease = Promise.withResolvers<void>()
    const retired = this.slots.splice(0)
    this.conversionSlot = undefined
    try {
      await Promise.all([...this.retiring, ...retired.map((slot) => slot.close())])
      return lease
    } catch (error) {
      this.releaseSourceReaders(lease)
      throw error
    }
  }

  releaseSourceReaders(lease: AbortController): void {
    if (this.sourceLease === lease) {
      this.sourceLease = undefined
      this.sourceRelease?.resolve()
      this.sourceRelease = undefined
    }
  }

  private async releaseSourceLease(): Promise<void> {
    if (this.sourceLease) {
      this.sourceLease.abort()
      await this.sourceRelease?.promise
    }
  }

  async importState(sessionId: string) {
    const response = await this.slot().request({ kind: 'import-state', sessionId })
    if (response.type !== 'import-state') {
      throw new Error('journal reader returned no import state')
    }
    return response.state
  }

  async conversionStorage(sessionId?: string, sizedAt?: string) {
    const reader = await this.conversionReader()
    const response = await reader.request({ kind: 'conversion-storage', sessionId, sizedAt })
    if (response.type !== 'conversion-storage') {
      throw new Error('journal reader returned no conversion storage')
    }
    return response.storage
  }

  async database(operation: JournalSqlDatabaseRead): Promise<JournalSqlDatabaseReadResult> {
    const response = await this.slot(false, operation).request({ kind: 'database', operation })
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

  private slot(forFork = false, databaseRead?: JournalSqlDatabaseRead): ReaderSlot {
    if (this.closed) {
      throw new Error('journal SQL reader pool is closed')
    }
    if (databaseRead?.kind !== 'records') {
      this.assertReadable?.()
    }
    retireFailedJournalReaderSlots(this.slots, this.replaced, this.retiring)
    let slot = this.slots
      .filter((slot) => slot !== this.forkSlot && (!forFork || slot !== this.conversionSlot))
      .toSorted((a, b) => a.pendingCount - b.pendingCount)[0]
    if ((!slot || slot.pendingCount > 0) && this.slots.length < JOURNAL_SQL_READERS) {
      slot = new ReaderSlot(
        this.filename,
        this.originalFilename,
        this.workerPath,
        new JournalReaderAdmission(),
        this.replyCredit
      )
      this.slots.push(slot)
    }
    this.idleRetirer.schedule({
      isClosed: () => this.closed,
      slots: this.slots,
      getForkSlot: () => this.forkSlot,
      getConversionSlot: () => this.conversionSlot,
      clearConversionSlot: () => {
        this.conversionSlot = undefined
      },
      replaced: this.replaced,
      retiring: this.retiring
    })
    return slot!
  }

  close(): Promise<void> {
    this.idleRetirer.cancel()
    this.sourceLease?.abort()
    this.closed = true
    this.forkRelease?.resolve()
    return (this.closing ??= Promise.all([
      this.sourceRelease?.promise,
      ...this.retiring,
      ...this.slots.map((slot) => slot.close())
    ]).then(() => {}))
  }
}

/** The source transaction is released before this reader emits any child page. */
export { JournalSqlForkReader, JournalSqlConversionReader } from './journal-sql-reader-reservations'
