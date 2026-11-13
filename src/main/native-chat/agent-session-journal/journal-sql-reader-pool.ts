import type { LegacyProofCursor } from './journal-legacy-source-proof'
import type { JournalSqlForkReader, JournalSqlConversionReader } from './journal-sql-reader-slot'
import { ReaderSlot } from './journal-sql-reader-slot'
import type { JournalForkPreparationInput } from './journal-fork-preparation'
import { throwIfSignalAborted } from '../../../shared/abort-signal-reason'
import type { JournalOutlineCache } from './journal-domain-outline'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import type { AgentSessionHistoryResult } from '../../../shared/agent-session/agent-session-wire'
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
  private sourceLease?: AbortController
  private sourceRelease?: PromiseWithResolvers<void>
  private forkSlot?: ReaderSlot
  private forkRelease?: PromiseWithResolvers<void>

  constructor(
    private readonly filename: string,
    private readonly originalFilename: string,
    private readonly workerPath = resolveWorkerThreadEntryPath(
      currentWorkerEntryLayout(__dirname),
      'journal-sql-reader-entry.js'
    ),
    private readonly cacheOutline?: (cache: JournalOutlineCache) => void,
    private readonly assertReadable?: () => void
  ) {}

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
    const response = await this.slot().request({ kind: 'domain-history', request })
    if (response.type !== 'page') {
      throw new Error('journal reader returned no domain history page')
    }
    return response.result
  }

  async prepareConversion(sessionId: string): Promise<JournalSqlConversionReader | null> {
    await this.releaseSourceLease()
    if (!this.conversionSlot || this.conversionSlot.failed) {
      this.conversionSlot = this.slot()
    }
    return this.conversionSlot.prepareConversion(sessionId)
  }

  async legacyProof(cursor: LegacyProofCursor) {
    await this.releaseSourceLease()
    this.conversionSlot ??= this.slot()
    const response = await this.conversionSlot.request({ kind: 'legacy-proof', cursor })
    if (response.type !== 'legacy-proof') {
      throw new Error('legacy proof reader returned no page')
    }
    return response.page
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
    for (let index = this.slots.length - 1; index >= 0; index--) {
      if (this.slots[index]!.failed) {
        const [failed] = this.slots.splice(index, 1)
        const closed = failed!.close().finally(() => this.retiring.delete(closed))
        this.retiring.add(closed)
      }
    }
    let slot = this.slots
      .filter((slot) => slot !== this.forkSlot && (!forFork || slot !== this.conversionSlot))
      .toSorted((a, b) => a.pendingCount - b.pendingCount)[0]
    if ((!slot || slot.pendingCount > 0) && this.slots.length < 4) {
      slot = new ReaderSlot(this.filename, this.originalFilename, this.workerPath)
      this.slots.push(slot)
    }
    return slot!
  }

  close(): Promise<void> {
    this.sourceLease?.abort()
    this.closed = true
    this.forkRelease?.resolve()
    return (this.closing ??= Promise.all([
      ...this.retiring,
      ...this.slots.map((slot) => slot.close())
    ]).then(() => {}))
  }
}

/** The source transaction is released before this reader emits any child page. */
export { JournalSqlForkReader, JournalSqlConversionReader } from './journal-sql-reader-slot'
