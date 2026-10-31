import {
  readJournalInputPlace,
  restoreJournalInputPlaces,
  currentJournalInputIdentity,
  journalInputOrderChanged,
  isJournalInputOverride
} from './journal-input-order-state'
export type { JournalInputPlace } from './journal-input-order-state'

import { JournalSubmissionLinks } from './journal-submission-links'
import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { QueuedMessageRow } from './queued-message-table'
import type { InputPlaceQuery } from './journal-input-place-index'
import { JournalInputLineageOwner } from './journal-input-lineage'
import { JournalInputCardIndex } from './journal-input-card-index'

const owners = new WeakMap<JournalReducerState, JournalInputOrder>()
export function initializeJournalInputOrder(
  state: JournalReducerState,
  originalAcceptance?: (id: string) => AgentJournalCursor | undefined
): JournalInputOrder {
  const owner = new JournalInputOrder(state, originalAcceptance)
  owners.set(state, owner)
  return owner
}
export function journalInputOrder(state: JournalReducerState): JournalInputOrder {
  return owners.get(state) ?? initializeJournalInputOrder(state)
}
export function setJournalInputOrder(state: JournalReducerState, owner: JournalInputOrder): void {
  owners.set(state, owner)
}

/** Own admission places and shared command witnesses are reconstructed by the journal fold. */
export class JournalInputOrder {
  private readonly links = new JournalSubmissionLinks()
  private reconstructing = false
  private legacyPlaces = 0
  private readonly recoveryOwed = new Set<string>()
  private readonly originals = new Map<string, AgentJournalCursor | undefined>()
  private readonly unsettled = new Map<string, AgentJournalSubmission>()
  private readonly queued = new Map<string, AgentJournalSubmission>()
  private readonly entered = new Map<string, AgentJournalSubmission>()
  private readonly overrides = new Map<string, AgentJournalSubmission>()
  private pending: readonly AgentJournalSubmission[] | undefined
  readonly lineage: JournalInputLineageOwner
  private readonly cards: JournalInputCardIndex
  private receiptCount = 0
  private queueRevision = 0
  private revision = 0

  constructor(
    private readonly state: JournalReducerState,
    private readonly originalAcceptance?: (id: string) => AgentJournalCursor | undefined
  ) {
    this.lineage = new JournalInputLineageOwner(state.inputCards)
    this.cards = new JournalInputCardIndex(this.lineage)
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
    this.receiptCount = state.receipts.size
    this.queueRevision = state.queue.revision
    if (row.kind === 'epoch' && row.inputOrderLineage) {
      this.lineage.load(row.inputOrderLineage)
    }
    this.lineage.observe(row.seq)
    if (row.kind !== 'submission' || !row.handoverRecorded || row.queuedMessageId !== undefined) {
      return
    }
    if (this.state.inputEntries.has(row.clientMessageId)) {
      return
    }
    const place = this.cards.admission(state, row, this.originalAcceptance)
    if (place.context.basis === 'legacy') {
      this.legacyPlaces++
    }
    this.state.inputEntries.set(row.clientMessageId, {
      context: place.context,
      ...(place.witnessCardId ? { witnessCardId: place.witnessCardId } : {})
    })
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
    for (const id of state.submissions.keys()) {
      this.refresh(state, id)
    }
    this.lineage.restoreFrontier(state.lastSequence, state.inputEntries.values())
  }

  linkedVersion(): number {
    return this.links.version()
  }
  linkedTo(id: string): Iterable<AgentJournalSubmission> {
    return this.links.to(id)
  }
  overlay(state: JournalReducerState, rows: readonly QueuedMessageRow[]): void {
    this.cards.overlay(state, rows)
  }
  introduceOverlays(state: JournalReducerState): void {
    this.cards.introduceOverlays((card) => this.queueChanged(state, undefined, card))
  }

  markOpeningRecovery(): void {
    for (const entry of this.unsettled.values()) {
      if (isQueuedAgentJournalSubmission(entry)) {
        this.markRecoveryPending(entry.clientMessageId)
      }
    }
  }

  markRecoveryPending(id: string): void {
    this.recoveryOwed.add(id)
    const queued = this.queued.delete(id)
    const override = this.overrides.delete(id)
    if (queued || override) {
      this.revision++
    }
  }
  recoveryPending(id: string): boolean {
    return this.recoveryOwed.has(id)
  }
  carryRecovery(previous: JournalInputOrder): void {
    for (const id of previous.recoveryOwed) {
      if (this.queued.has(id)) {
        this.markRecoveryPending(id)
      }
    }
  }

  place(id: string): ReturnType<typeof readJournalInputPlace> {
    return readJournalInputPlace(this.state, id, this.originals, this.originalAcceptance)
  }
  forced(id: string): boolean {
    return this.state.inputEntries.get(id)?.witnessCardId !== undefined
  }
  firstQueued(): AgentJournalSubmission | undefined {
    return this.queued.values().next().value
  }
  explicitSend(): AgentJournalSubmission | undefined {
    return this.overrides.values().next().value
  }
  enteredSubmissions(): Iterable<AgentJournalSubmission> {
    return this.entered.values()
  }
  unsettledSubmissions(): readonly AgentJournalSubmission[] {
    return (this.pending ??= [...this.unsettled.values()])
  }
  version(): number {
    return this.revision
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
    this.cards.queueChanged(state, prior, card)
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

  afterRow(state: JournalReducerState, row: JournalRow): void {
    if (journalInputOrderChanged(state, row, (key) => this[key])) {
      this.revision++
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
    const identity = parseAgentJournalItemKey(itemId)
    if (identity?.provider === 'orca') {
      this.refresh(state, identity.clientMessageId)
    }
  }

  private refresh(state: JournalReducerState, id: string): void {
    const entry = state.submissions.get(id)
    this.links.refresh(id, entry)
    if (entry?.dispatchState === 'pending' || entry?.dispatchState === 'unknown') {
      if (this.unsettled.get(id) !== entry) {
        this.unsettled.set(id, entry)
        this.pending = undefined
        this.revision++
      }
    } else if (this.unsettled.delete(id)) {
      this.pending = undefined
      this.revision++
    }
    if (entry?.dispatchState !== 'pending') {
      this.releasePlace(state, id)
    }
    if (entry && isQueuedAgentJournalSubmission(entry)) {
      if (!this.recoveryOwed.has(id)) {
        this.queued.set(id, entry)
      }
      this.entered.delete(id)
      if (isJournalInputOverride(entry, this.recoveryOwed.has(id))) {
        this.overrides.set(id, entry)
      }
    } else {
      this.recoveryOwed.delete(id)
      this.queued.delete(id)
      this.overrides.delete(id)
      if (entry && (entry.dispatchState === 'pending' || entry.dispatchState === 'unknown')) {
        this.entered.set(id, entry)
      } else {
        this.entered.delete(id)
      }
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
      this.originals.delete(id)
      if (place.context.basis === 'legacy' && --this.legacyPlaces === 0 && !this.reconstructing) {
        this.releaseHistory(state)
      }
    }
  }

  private releaseHistory(state: JournalReducerState): void {
    this.lineage.releaseHistory((id) => this.currentIdentity(state, id))
    this.cards.releaseHistory()
  }

  precedes(card: QueuedMessageRow, submission: AgentJournalSubmission): boolean {
    const place = this.place(submission.clientMessageId)
    return Boolean(place?.witnessCardId && this.cards.relation(card, place))
  }
}
