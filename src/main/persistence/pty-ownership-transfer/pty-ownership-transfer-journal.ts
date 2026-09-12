import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import type { WriteSchedulingOperations } from '../loading-store/write-scheduling'
import { scheduleSave } from '../loading-store/write-scheduling'
import {
  assertPtyOwnershipTransferIdentity,
  MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS,
  parsePtyOwnershipTransferJournal,
  type PtyOwnershipTransferCommitReceipt,
  type PtyOwnershipTransferDestinationJournal,
  type PtyOwnershipTransferIdentity,
  type PtyOwnershipTransferJournal,
  type PtyOwnershipTransferPublicationReceipt,
  type PtyOwnershipTransferSourceJournal
} from '../../../shared/pty-ownership-transfer-journal'
import {
  abortPtyOwnershipTransferJournal,
  advancePtyOwnershipTransferDestinationCursor,
  advancePtyOwnershipTransferSourceOutput,
  commitPtyOwnershipTransferDestination,
  observePtyOwnershipTransferSourceCommit,
  observePtyOwnershipTransferSourcePublication,
  publishPtyOwnershipTransferDestination,
  retirePtyOwnershipTransferSourceJournal
} from './pty-ownership-transfer-journal-transitions'
import { compactCompletedPtyOwnershipTransferJournals } from './pty-ownership-transfer-journal-compaction'

type PtyOwnershipTransferJournalRuntime = Pick<StoreRuntimeState, 'state'>
const journalContext = Symbol('PtyOwnershipTransferJournalPersistence')

type JournalContext = {
  runtime: PtyOwnershipTransferJournalRuntime
  scheduling: WriteSchedulingOperations
}

export class PtyOwnershipTransferJournalPersistence {
  readonly [journalContext]: JournalContext

  constructor(runtime: PtyOwnershipTransferJournalRuntime, scheduling: WriteSchedulingOperations) {
    this[journalContext] = { runtime, scheduling }
  }

  listPtyOwnershipTransferJournals(): PtyOwnershipTransferJournal[] {
    return structuredClone(this[journalContext].runtime.state.ptyOwnershipTransferJournals ?? [])
  }

  getPtyOwnershipTransferJournal(
    bridgeId: string,
    side: PtyOwnershipTransferJournal['side']
  ): PtyOwnershipTransferJournal | null {
    const journal = this.find(bridgeId, side)
    return journal ? structuredClone(journal) : null
  }

  beginPtyOwnershipTransferSource(
    identity: PtyOwnershipTransferIdentity,
    sourceOutputEndSeq: number,
    options: { now?: () => Date } = {}
  ): PtyOwnershipTransferSourceJournal {
    requireSequence(sourceOutputEndSeq, 'pty_ownership_transfer_source_output_invalid')
    const existing = this.find(identity.bridgeId, 'source')
    if (existing) {
      assertPtyOwnershipTransferIdentity(existing, identity)
      if (existing.phase === 'aborted') {
        throw new Error('pty_ownership_transfer_id_aborted')
      }
      if (existing.sourceOutputEndSeq !== sourceOutputEndSeq) {
        throw new Error('pty_ownership_transfer_source_cursor_conflict')
      }
      return structuredClone(existing)
    }
    this.requireCapacity()
    const timestamp = (options.now ?? (() => new Date()))().toISOString()
    const journal = parseSourceJournal({
      ...identity,
      version: 1,
      side: 'source',
      phase: 'prepared',
      sourceOutputEndSeq,
      destinationOutputEndSeq: 0,
      startedAt: timestamp,
      updatedAt: timestamp
    })
    this.replace(journal)
    return structuredClone(journal)
  }

  beginPtyOwnershipTransferDestination(
    identity: PtyOwnershipTransferIdentity,
    acceptedSourceEndSeq: number,
    options: { now?: () => Date } = {}
  ): PtyOwnershipTransferDestinationJournal {
    requireSequence(acceptedSourceEndSeq, 'pty_ownership_transfer_destination_cursor_invalid')
    const existing = this.find(identity.bridgeId, 'destination')
    if (existing) {
      assertPtyOwnershipTransferIdentity(existing, identity)
      if (existing.phase === 'aborted') {
        throw new Error('pty_ownership_transfer_id_aborted')
      }
      if (existing.acceptedSourceEndSeq !== acceptedSourceEndSeq) {
        throw new Error('pty_ownership_transfer_destination_cursor_conflict')
      }
      return structuredClone(existing)
    }
    this.requireCapacity()
    const timestamp = (options.now ?? (() => new Date()))().toISOString()
    const journal = parseDestinationJournal({
      ...identity,
      version: 1,
      side: 'destination',
      phase: 'prepared',
      acceptedSourceEndSeq,
      startedAt: timestamp,
      updatedAt: timestamp
    })
    this.replace(journal)
    return structuredClone(journal)
  }

  markPtyOwnershipTransferDestinationCommitted(
    identity: PtyOwnershipTransferIdentity,
    receipt: PtyOwnershipTransferCommitReceipt,
    options: { now?: () => Date } = {}
  ): PtyOwnershipTransferDestinationJournal {
    const current = this.require(identity, 'destination')
    const next = commitPtyOwnershipTransferDestination(current, identity, receipt, options)
    return this.persistTransition(current, next)
  }

  advancePtyOwnershipTransferSourceOutput(
    identity: PtyOwnershipTransferIdentity,
    sourceOutputEndSeq: number,
    options: { now?: () => Date } = {}
  ): PtyOwnershipTransferSourceJournal {
    const current = this.require(identity, 'source')
    const next = advancePtyOwnershipTransferSourceOutput(current, sourceOutputEndSeq, options)
    return this.persistTransition(current, next)
  }

  advancePtyOwnershipTransferDestinationCursor(
    identity: PtyOwnershipTransferIdentity,
    acceptedSourceEndSeq: number,
    options: { now?: () => Date } = {}
  ): PtyOwnershipTransferDestinationJournal {
    const current = this.require(identity, 'destination')
    const next = advancePtyOwnershipTransferDestinationCursor(
      current,
      acceptedSourceEndSeq,
      options
    )
    return this.persistTransition(current, next)
  }

  markPtyOwnershipTransferSourceCommitObserved(
    identity: PtyOwnershipTransferIdentity,
    receipt: PtyOwnershipTransferCommitReceipt,
    options: { now?: () => Date } = {}
  ): PtyOwnershipTransferSourceJournal {
    const current = this.require(identity, 'source')
    const next = observePtyOwnershipTransferSourceCommit(current, identity, receipt, options)
    return this.persistTransition(current, next)
  }

  markPtyOwnershipTransferDestinationPublished(
    identity: PtyOwnershipTransferIdentity,
    publicationReceipt: PtyOwnershipTransferPublicationReceipt
  ): PtyOwnershipTransferDestinationJournal {
    const current = this.require(identity, 'destination')
    const next = publishPtyOwnershipTransferDestination(current, identity, publicationReceipt)
    return this.persistTransition(current, next)
  }

  markPtyOwnershipTransferSourcePublicationObserved(
    identity: PtyOwnershipTransferIdentity,
    publicationReceipt: PtyOwnershipTransferPublicationReceipt,
    options: { now?: () => Date } = {}
  ): PtyOwnershipTransferSourceJournal {
    const current = this.require(identity, 'source')
    const next = observePtyOwnershipTransferSourcePublication(
      current,
      identity,
      publicationReceipt,
      options
    )
    return this.persistTransition(current, next)
  }

  retirePtyOwnershipTransferSource(
    identity: PtyOwnershipTransferIdentity,
    options: { now?: () => Date } = {}
  ): PtyOwnershipTransferSourceJournal {
    const current = this.require(identity, 'source')
    const next = retirePtyOwnershipTransferSourceJournal(current, options)
    return this.persistTransition(current, next)
  }

  abortPtyOwnershipTransfer(
    identity: PtyOwnershipTransferIdentity,
    side: PtyOwnershipTransferJournal['side'],
    options: { now?: () => Date } = {}
  ): PtyOwnershipTransferJournal {
    const current = this.require(identity, side)
    const next = abortPtyOwnershipTransferJournal(current, options)
    return this.persistTransition(current, next)
  }

  private find(bridgeId: string, side: 'source'): PtyOwnershipTransferSourceJournal | undefined
  private find(
    bridgeId: string,
    side: 'destination'
  ): PtyOwnershipTransferDestinationJournal | undefined
  private find(
    bridgeId: string,
    side: PtyOwnershipTransferJournal['side']
  ): PtyOwnershipTransferJournal | undefined
  private find(
    bridgeId: string,
    side: PtyOwnershipTransferJournal['side']
  ): PtyOwnershipTransferJournal | undefined {
    return this[journalContext].runtime.state.ptyOwnershipTransferJournals?.find(
      (journal) => journal.bridgeId === bridgeId && journal.side === side
    )
  }

  private require<TSide extends PtyOwnershipTransferJournal['side']>(
    identity: PtyOwnershipTransferIdentity,
    side: TSide
  ): Extract<PtyOwnershipTransferJournal, { side: TSide }> {
    const current = this.find(identity.bridgeId, side)
    if (!current) {
      throw new Error('pty_ownership_transfer_journal_not_found')
    }
    assertPtyOwnershipTransferIdentity(current, identity)
    return current as Extract<PtyOwnershipTransferJournal, { side: TSide }>
  }

  private requireCapacity(): void {
    const context = this[journalContext]
    const journals = context.runtime.state.ptyOwnershipTransferJournals ?? []
    if (journals.length < MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS) {
      return
    }
    const compacted = compactCompletedPtyOwnershipTransferJournals(journals)
    if (!compacted) {
      throw new Error('pty_ownership_transfer_journal_capacity_exceeded')
    }
    context.runtime.state.ptyOwnershipTransferJournals = compacted
    scheduleSave(context.scheduling)
  }

  private persistTransition<TJournal extends PtyOwnershipTransferJournal>(
    current: TJournal,
    next: TJournal
  ): TJournal {
    if (current !== next) {
      this.replace(next)
    }
    return structuredClone(next)
  }

  private replace(journal: PtyOwnershipTransferJournal): void {
    const context = this[journalContext]
    const journals = context.runtime.state.ptyOwnershipTransferJournals ?? []
    const index = journals.findIndex(
      (candidate) => candidate.bridgeId === journal.bridgeId && candidate.side === journal.side
    )
    context.runtime.state.ptyOwnershipTransferJournals =
      index === -1
        ? [...journals, structuredClone(journal)]
        : journals.map((candidate, candidateIndex) =>
            candidateIndex === index ? structuredClone(journal) : candidate
          )
    scheduleSave(context.scheduling)
  }
}

function parseSourceJournal(value: unknown): PtyOwnershipTransferSourceJournal {
  const journal = parsePtyOwnershipTransferJournal(value)
  if (journal.side !== 'source') {
    throw new Error('pty_ownership_transfer_source_side_invalid')
  }
  return journal
}

function parseDestinationJournal(value: unknown): PtyOwnershipTransferDestinationJournal {
  const journal = parsePtyOwnershipTransferJournal(value)
  if (journal.side !== 'destination') {
    throw new Error('pty_ownership_transfer_destination_side_invalid')
  }
  return journal
}

function requireSequence(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(code)
  }
}

export function installPtyOwnershipTransferJournalPersistenceContext(
  target: object,
  source: PtyOwnershipTransferJournalPersistence
): void {
  Object.defineProperty(target, journalContext, {
    value: source[journalContext]
  })
}
