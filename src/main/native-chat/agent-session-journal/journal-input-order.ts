import { memoryJournalMap } from './journal-memory-collections'
import type { JournalInputOrderFacts } from './journal-input-facts-storage'
import type { JournalSubmissionStorage, JournalIndexStorageFactory } from './journal-index-storage'
import {
  readJournalInputPlace,
  restoreJournalInputPlaces,
  currentJournalInputIdentity,
  journalInputOrderChanged,
  isJournalInputOverride,
  recordJournalInputAdmission,
  releaseJournalInputHistory
} from './journal-input-order-state'
export type { JournalInputPlace } from './journal-input-order-state'

import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { memoryJournalIndexStorage } from './journal-memory-index-storage'
import { JournalNewestTurn } from './journal-newest-turn'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { QueuedMessageRow } from './queued-message-table'
import type { InputPlaceQuery } from './journal-input-place-index'
import { JournalInputEvidence } from './journal-input-evidence'
import { JournalInputLineageOwner } from './journal-input-lineage'
import { JournalInputCardIndex } from './journal-input-card-index'

export {
  initializeJournalInputOrder,
  journalInputOrder,
  setJournalInputOrder
} from './journal-input-order-registry'

/** Own admission places and shared command witnesses are reconstructed by the journal fold. */
export class JournalInputOrder extends JournalInputEvidence {
  private readonly orderFacts: JournalInputOrderFacts
  private readonly unsettled: JournalSubmissionStorage
  // Recovered unknown sends stay unsettled forever; only pending ones can still be accepted.
  private readonly sending: JournalSubmissionStorage
  readonly newestTurn: JournalNewestTurn
  readonly lineage: JournalInputLineageOwner
  readonly cards: JournalInputCardIndex

  constructor(
    state: JournalReducerState,
    private readonly originalAcceptance?: (id: string) => AgentJournalCursor | undefined,
    newestTurn: JournalNewestTurn | undefined = undefined,
    indexes: JournalIndexStorageFactory = memoryJournalIndexStorage
  ) {
    super(state, indexes)
    this.orderFacts = indexes.orderFacts()
    this.newestTurn = newestTurn ?? new JournalNewestTurn(state, indexes.newestTurn())
    this.unsettled = indexes.submissions('unsettled')
    this.sending = indexes.submissions('sending')
    const lineageCards = state.inputCards
    this.lineage = new JournalInputLineageOwner(lineageCards, indexes.lineageFacts(lineageCards))
    this.cards = new JournalInputCardIndex(this.lineage, indexes)
  }

  beforeRow(state: JournalReducerState, row: JournalRow): void {
    if (row.kind === 'dispatch' && row.keptAsQueuedMessageId) {
      const place = this.place(row.clientMessageId)
      if (place && !this.lineage.cards.has(row.keptAsQueuedMessageId)) {
        this.lineage.cards.set(row.keptAsQueuedMessageId, {
          introduced: place.context.cut,
          baseline: { coordinate: place.coordinate }
        })
      }
    }
    this.orderFacts.receiptCount = state.receipts.size
    this.orderFacts.queueRevision = state.queue.revision
    if (row.kind === 'epoch' && row.inputOrderLineage) {
      this.lineage.load(row.inputOrderLineage)
    }
    this.lineage.observe(row.seq)
    if (
      recordJournalInputAdmission(state, row, this.cards, this.originalAcceptance, (id) =>
        this.releasePlace(state, id)
      )
    ) {
      this.orderFacts.legacyPlaces++
    }
  }

  // A streaming prefix cannot establish the last legacy consumer.
  beginReconstruction(): void {
    this.orderFacts.reconstructing = true
    this.orderFacts.legacyPlaces = this.state.queries.legacyInputEntryCount(this.state)
  }
  finishReconstruction(state: JournalReducerState): void {
    this.orderFacts.reconstructing = false
    if (this.orderFacts.legacyPlaces === 0) {
      this.releaseHistory(state)
    }
  }

  restore(state: JournalReducerState): void {
    this.orderFacts.legacyPlaces = restoreJournalInputPlaces(state)
    this.cards.ensure(state)
    for (const id of memoryJournalMap(state.submissions).keys()) {
      this.refresh(state, id)
    }
    this.lineage.restoreFrontier(state.lastSequence, state.inputEntries)
  }

  overlay(state: JournalReducerState, rows: readonly QueuedMessageRow[]): void {
    this.cards.overlay(state, rows)
  }
  introduceOverlays(state: JournalReducerState): void {
    this.cards.introduceOverlays((card) => this.queueChanged(state, undefined, card))
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
    const queued = this.orderFacts.queued.delete(id)
    const override = this.orderFacts.overrides.delete(id)
    if (queued || override) {
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

  place(id: string): ReturnType<typeof readJournalInputPlace> {
    return readJournalInputPlace(this.state, id, this.orderFacts.originals, this.originalAcceptance)
  }
  forced(id: string): boolean {
    return this.state.inputEntries.get(id)?.witnessCardId !== undefined
  }
  firstQueued(): AgentJournalSubmission | undefined {
    return this.orderFacts.firstQueued()
  }
  explicitSend(): AgentJournalSubmission | undefined {
    return this.orderFacts.explicitSend()
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

  predecessors(state: JournalReducerState, id: string): InputPlaceQuery {
    this.cards.ensure(state)
    const place = this.place(id)
    return place?.witnessCardId ? this.cards.query(place) : { position: -Infinity }
  }

  queueChanged(
    state: JournalReducerState,
    prior: QueuedMessageRow | undefined,
    card: QueuedMessageRow
  ): void {
    this.cards.queueChanged(
      state,
      prior,
      card,
      this.orderFacts.reconstructing || this.orderFacts.legacyPlaces > 0
    )
    if (!this.orderFacts.reconstructing && this.orderFacts.legacyPlaces === 0) {
      const source = this.lineage.cards.get(card.messageId)
      if (source) {
        delete source.baseline
      }
    }
    if (
      card.state === 'withdrawn' &&
      !this.orderFacts.reconstructing &&
      this.orderFacts.legacyPlaces === 0
    ) {
      this.lineage.cards.delete(card.messageId)
    }
  }

  afterRow(state: JournalReducerState, row: JournalRow): void {
    this.newestTurn.afterRow(state, row)
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
    if (dispatch !== 'pending') {
      this.releasePlace(state, id)
    }
    if (entry && isQueuedAgentJournalSubmission(entry)) {
      if (!this.orderFacts.recoveryOwed.has(id)) {
        this.orderFacts.queued.set(id, entry)
      }
      this.orderFacts.entered.delete(id)
      if (isJournalInputOverride(entry, this.orderFacts.recoveryOwed.has(id))) {
        this.orderFacts.overrides.set(id, entry)
      }
    } else {
      this.orderFacts.recoveryOwed.delete(id)
      this.orderFacts.queued.delete(id)
      this.orderFacts.overrides.delete(id)
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
        if (
          !this.orderFacts.reconstructing &&
          this.orderFacts.legacyPlaces === 0 &&
          !this.currentIdentity(state, card.messageId)
        ) {
          this.cards.releaseCard(card.messageId, state.lastSequence)
          this.lineage.cards.delete(card.messageId)
        }
      }
    }
  }

  private currentIdentity(state: JournalReducerState, id: string): boolean {
    return currentJournalInputIdentity(state, id, () => this.cards.hasOverlay(id))
  }

  private releasePlace(state: JournalReducerState, id: string): void {
    const place = this.state.inputEntries.get(id)
    if (place && this.state.inputEntries.delete(id)) {
      this.orderFacts.originals.delete(id)
      if (
        place.context.basis === 'legacy' &&
        --this.orderFacts.legacyPlaces === 0 &&
        !this.orderFacts.reconstructing
      ) {
        this.releaseHistory(state)
      }
    }
  }

  private releaseHistory(state: JournalReducerState): void {
    releaseJournalInputHistory(state, this.lineage, this.cards)
  }

  precedes(card: QueuedMessageRow, submission: AgentJournalSubmission): boolean {
    const place = this.place(submission.clientMessageId)
    return Boolean(place?.witnessCardId && this.cards.relation(card, place))
  }
}
