import { parseAgentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import type { QueuedMessageRow } from '../queued-messages/queued-message-table'
import { LegacyQueueCardIndex } from './legacy-queue-card-index'
import type { JournalInputOrderResolver } from './journal-input-order-registry'
import { JournalInputLineageOwner } from './journal-input-lineage'
import {
  currentJournalInputIdentity,
  readJournalInputPlace,
  restoreJournalInputPlaces,
  recordJournalInputAdmission,
  releaseJournalInputHistory
} from './journal-input-order-state'

/** Open-time decoder of saved queue places; format-3 runtime never owns this reader. */
export class LegacyQueueOrderReader {
  private reconstructing = false
  private legacyPlaces = 0
  private readonly originals = new Map<string, AgentJournalCursor | undefined>()
  readonly lineage: JournalInputLineageOwner
  readonly cards: LegacyQueueCardIndex
  constructor(
    private readonly state: JournalReducerState,
    journalInputOrder: JournalInputOrderResolver,
    private readonly originalAcceptance?: (id: string) => AgentJournalCursor | undefined
  ) {
    this.lineage = new JournalInputLineageOwner(state.inputCards)
    this.cards = new LegacyQueueCardIndex(this.lineage, journalInputOrder)
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
    if (row.kind === 'epoch' && row.inputOrderLineage) {
      this.lineage.load(row.inputOrderLineage)
    }
    this.lineage.observe(row.seq)
    if (
      recordJournalInputAdmission(state, row, this.cards, this.originalAcceptance, (id) =>
        this.releasePlace(state, id)
      )
    ) {
      this.legacyPlaces++
    }
  }

  // A streaming prefix cannot establish the last legacy consumer.
  beginReconstruction(): void {
    this.reconstructing = true
    this.legacyPlaces = 0
    for (const entry of this.state.inputEntries.values()) {
      if (entry.context.basis === 'legacy') {
        this.legacyPlaces++
      }
    }
  }
  finishReconstruction(state: JournalReducerState): void {
    this.reconstructing = false
    if (this.legacyPlaces === 0) {
      this.releaseHistory(state)
    }
  }

  restore(state: JournalReducerState): void {
    this.legacyPlaces = restoreJournalInputPlaces(state)
    this.cards.ensure(state)
    this.lineage.restoreFrontier(state.lastSequence, state.inputEntries.values())
  }

  overlay(state: JournalReducerState, rows: readonly QueuedMessageRow[]): void {
    this.cards.overlay(state, rows)
  }

  queueChanged(
    state: JournalReducerState,
    prior: QueuedMessageRow | undefined,
    card: QueuedMessageRow
  ): void {
    this.cards.queueChanged(state, prior, card, this.reconstructing || this.legacyPlaces > 0)
    if (!this.reconstructing && this.legacyPlaces === 0) {
      const source = this.lineage.cards.get(card.messageId)
      if (source) {
        delete source.baseline
      }
    }
    if (card.state === 'withdrawn' && !this.reconstructing && this.legacyPlaces === 0) {
      this.lineage.cards.delete(card.messageId)
    }
  }

  private currentIdentity(state: JournalReducerState, id: string): boolean {
    return currentJournalInputIdentity(state, id, () => this.cards.hasOverlay(id))
  }

  private releasePlace(state: JournalReducerState, id: string): void {
    const place = this.state.inputEntries.get(id)
    if (place && this.state.inputEntries.delete(id)) {
      this.originals.delete(id)
      if (place.context.basis === 'legacy' && --this.legacyPlaces === 0 && !this.reconstructing) {
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
  place(id: string) {
    return readJournalInputPlace(this.state, id, this.originals, this.originalAcceptance)
  }
  forced(id: string): boolean {
    return this.state.inputEntries.get(id)?.witnessCardId !== undefined
  }
  predecessors(state: JournalReducerState, id: string) {
    this.cards.ensure(state)
    const place = this.place(id)
    return place?.witnessCardId ? this.cards.query(place) : { position: -Infinity }
  }
  afterRow(state: JournalReducerState, row: JournalRow): void {
    const refreshItem = (itemId: string) => {
      const identity = parseAgentJournalItemKey(state.aliases.get(itemId) ?? itemId)
      if (identity?.provider === 'orca') {
        this.refresh(state, identity.clientMessageId)
      }
    }
    if (row.kind === 'submission' || row.kind === 'dispatch') {
      this.refresh(state, row.clientMessageId)
    } else if (row.kind === 'item' || (row.kind === 'tombstone' && row.retireSubmission)) {
      refreshItem(row.itemId)
    } else if (row.kind === 'lifecycle-batch') {
      for (const mutation of row.mutations) {
        refreshItem(mutation.itemId)
      }
    } else if (row.kind === 'queue') {
      const id = state.queue.cards.get(row.messageId)?.consumedAs
      if (id) {
        this.refresh(state, id)
      }
    }
  }
  private refresh(state: JournalReducerState, id: string): void {
    const entry = state.submissions.get(id)
    if (entry?.dispatchState !== 'pending') {
      this.releasePlace(state, id)
    }
    if (entry?.queuedMessageId) {
      const card = state.queue.cards.get(entry.queuedMessageId)
      if (card?.consumedAs === id) {
        this.cards.indexCard(state, card)
        if (
          !this.reconstructing &&
          this.legacyPlaces === 0 &&
          !this.currentIdentity(state, card.messageId)
        ) {
          this.cards.releaseCard(card.messageId, state.lastSequence)
          this.lineage.cards.delete(card.messageId)
        }
      }
    }
  }
}
