import { getJournalInputOrder, setJournalInputOrder } from './journal-input-order-registry'
import { memoryJournalMap } from '../journal-memory-collections'
import type { JournalInputOrderFacts } from '../journal-input-facts-storage'
import type { JournalSubmissionStorage, JournalInputIndexStorage } from '../journal-index-storage'
import { journalInputOrderChanged } from './journal-input-order-state'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { memoryJournalInputIndexStorage } from '../journal-memory-input-index-storage'
import { JournalNewestTurn } from './journal-newest-turn'
import { isQueuedAgentJournalSubmission } from '../../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import type { QueuedMessageRow } from '../queued-messages/queued-message-table'
import { JournalInputEvidence } from './journal-input-evidence'
import { LegacyQueueOrderReader } from './legacy-queue-order-reader'
import { JournalInputCardIndex } from './journal-input-card-index'

/** Delivery evidence and the current hand-off; every other waiting input has a queue row. */
export class JournalInputOrder extends JournalInputEvidence {
  /** Present only while an old saved queue is being decoded and converted. */
  legacy: LegacyQueueOrderReader | undefined
  private readonly orderFacts: JournalInputOrderFacts
  private readonly unsettled: JournalSubmissionStorage
  // Recovered unknown sends stay unsettled forever; only pending ones can still be accepted.
  private readonly sending: JournalSubmissionStorage
  readonly newestTurn: JournalNewestTurn
  readonly cards: JournalInputCardIndex

  constructor(
    state: JournalReducerState,
    newestTurn: JournalNewestTurn | undefined = undefined,
    indexes: JournalInputIndexStorage = memoryJournalInputIndexStorage
  ) {
    super(state, indexes)
    this.orderFacts = indexes.orderFacts()
    this.newestTurn = newestTurn ?? new JournalNewestTurn(state, indexes.newestTurn())
    this.unsettled = indexes.submissions('unsettled')
    this.sending = indexes.submissions('sending')
    this.cards = new JournalInputCardIndex(journalInputOrder, indexes)
  }

  beforeRow(state: JournalReducerState, row: JournalRow): void {
    this.orderFacts.receiptCount = state.receipts.size
    this.orderFacts.queueRevision = state.queue.revision
    this.legacy?.beforeRow(state, row)
  }
  beginReconstruction(): void {
    this.legacy ??= new LegacyQueueOrderReader(this.state, journalInputOrder)
    this.legacy.beginReconstruction()
  }
  finishReconstruction(state: JournalReducerState): void {
    this.legacy?.finishReconstruction(state)
  }
  restore(state: JournalReducerState): void {
    this.legacy?.restore(state)
    this.cards.ensure(state)
    for (const id of memoryJournalMap(state.submissions).keys()) {
      this.refresh(state, id)
    }
  }
  overlay(state: JournalReducerState, rows: readonly QueuedMessageRow[]): void {
    this.legacy?.overlay(state, rows)
    this.cards.overlay(state, rows)
  }
  introduceOverlays(state: JournalReducerState): void {
    this.legacy?.cards.introduceOverlays((card) =>
      this.legacy?.queueChanged(state, undefined, card)
    )
  }
  completeQueueConversion(state: JournalReducerState): void {
    this.legacy = undefined
    state.inputEntries.clear()
    state.inputCards.clear()
  }
  queueFormat(): 2 | 3 {
    return this.legacy ? 2 : 3
  }

  markOpeningRecovery(): void {
    for (const entry of this.unsettled.list()) {
      if (isQueuedAgentJournalSubmission(entry)) {
        this.markRecoveryPending(entry.clientMessageId)
      }
    }
  }

  markRecoveryPending(id: string): void {
    this.orderFacts.recoveryOwed.add(id)
    if (this.orderFacts.queued.delete(id)) {
      this.orderFacts.revision++
    }
  }
  recoveryPending(id: string): boolean {
    return this.orderFacts.recoveryOwed.has(id)
  }
  carryRecovery(previous: JournalInputOrder): void {
    for (const id of previous.orderFacts.recoveryOwedIds()) {
      if (this.orderFacts.queued.has(id)) {
        this.markRecoveryPending(id)
      }
    }
  }

  firstQueued(): AgentJournalSubmission | undefined {
    return this.orderFacts.firstQueued()
  }
  enteredSubmissions(): Iterable<AgentJournalSubmission> {
    return this.orderFacts.enteredSubmissions()
  }
  unsettledSubmissions(): readonly AgentJournalSubmission[] {
    return this.unsettled.list()
  }
  sendingSubmissions(): readonly AgentJournalSubmission[] {
    return this.sending.list()
  }
  version(): number {
    return this.orderFacts.revision
  }

  liveCards(state: JournalReducerState): Iterable<QueuedMessageRow> {
    this.cards.ensure(state)
    return this.cards.live()
  }
  cardVersion(state: JournalReducerState): number {
    this.cards.ensure(state)
    return this.cards.version()
  }
  cardBounds(state: JournalReducerState): { first: number; last: number } {
    this.cards.ensure(state)
    return this.cards.bounds()
  }
  head(state: JournalReducerState, floor: AgentJournalCursor | null): QueuedMessageRow | undefined {
    this.cards.ensure(state, floor)
    return this.cards.head()
  }
  paused(
    state: JournalReducerState,
    card: QueuedMessageRow,
    floor: AgentJournalCursor | null
  ): boolean {
    this.cards.ensure(state, floor)
    return this.cards.paused(card)
  }

  queueChanged(
    state: JournalReducerState,
    prior: QueuedMessageRow | undefined,
    card: QueuedMessageRow
  ): void {
    this.legacy?.queueChanged(state, prior, card)
    this.cards.ensure(state)
    this.cards.indexCard(state, card)
  }

  afterRow(state: JournalReducerState, row: JournalRow): void {
    this.newestTurn.afterRow(state, row)
    this.legacy?.afterRow(state, row)
    if (journalInputOrderChanged(state, row, (key) => this.orderFacts[key])) {
      this.orderFacts.revision++
    }
    if (row.kind === 'submission' || row.kind === 'dispatch') {
      this.refresh(state, row.clientMessageId)
    } else if (row.kind === 'tombstone' && row.retireSubmission) {
      this.refreshItem(state, row.itemId)
    } else if (row.kind === 'item') {
      this.refreshItem(state, state.aliases.get(row.itemId) ?? row.itemId)
    } else if (row.kind === 'lifecycle-batch') {
      for (const mutation of row.mutations) {
        this.refreshItem(state, state.aliases.get(mutation.itemId) ?? mutation.itemId)
      }
    } else if (row.kind === 'queue') {
      const id = state.queue.cards.get(row.messageId)?.consumedAs
      if (id) {
        this.refresh(state, id)
      }
    }
  }

  private refreshItem(state: JournalReducerState, itemId: string): void {
    const id = this.observationFacts.inputIds.get(itemId)
    if (id !== undefined) {
      this.refresh(state, id)
    }
  }

  private refresh(state: JournalReducerState, id: string): void {
    const entry = state.submissions.get(id)
    this.refreshInputEvidence(state, id, entry)
    this.refreshLink(id)
    const dispatch = entry?.dispatchState
    if (this.unsettled.keep(id, entry, dispatch === 'pending' || dispatch === 'unknown')) {
      this.orderFacts.revision++
    }
    this.sending.keep(id, entry, dispatch === 'pending')
    if (entry && isQueuedAgentJournalSubmission(entry)) {
      if (!this.orderFacts.recoveryOwed.has(id)) {
        this.orderFacts.queued.set(id, entry)
      }
      this.orderFacts.entered.delete(id)
    } else {
      this.orderFacts.recoveryOwed.delete(id)
      this.orderFacts.queued.delete(id)
      if (entry && (entry.dispatchState === 'pending' || entry.dispatchState === 'unknown')) {
        this.orderFacts.entered.set(id, entry)
      } else {
        this.orderFacts.entered.delete(id)
      }
    }
    if (entry?.queuedMessageId) {
      const card = state.queue.cards.get(entry.queuedMessageId)
      if (card?.consumedAs === id) {
        this.cards.indexCard(state, card)
      }
    }
  }
}

export function initializeJournalInputOrder(
  state: JournalReducerState,
  storage: JournalInputIndexStorage = memoryJournalInputIndexStorage
): JournalInputOrder {
  const owner = new JournalInputOrder(state, undefined, storage)
  setJournalInputOrder(state, owner)
  return owner
}

export function journalInputOrder(state: JournalReducerState): JournalInputOrder {
  return getJournalInputOrder(state) ?? initializeJournalInputOrder(state)
}
