import { finishJournalSteps } from './journal-reconstruction-steps'
import {
  readJournalInputPlace,
  restoreJournalInputPlacesSteps,
  currentJournalInputIdentity,
  journalInputOrderChanged,
  isJournalInputOverride,
  journalInputsNeedingAcceptance,
  journalInputAcceptanceIdsSteps,
  prepareJournalInputRow,
  refreshJournalInputRow
} from './journal-input-order-state'
export type { JournalInputPlace } from './journal-input-order-state'

import { JournalSubmissionLinks } from './journal-submission-links'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { QueuedMessageRow } from './queued-message-table'
import type { InputPlaceQuery } from './journal-input-place-index'
import { JournalInputLineageOwner } from './journal-input-lineage'
import { JournalInputCardIndex } from './journal-input-card-index'

export {
  initializeJournalInputOrder,
  journalInputOrder,
  setJournalInputOrder
} from './journal-input-order-owner'

/** Own admission places and shared command witnesses are reconstructed by the journal fold. */
export class JournalInputOrder {
  readonly links = new JournalSubmissionLinks()
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
  readonly cards: JournalInputCardIndex
  private receiptCount = 0
  private queueRevision = 0
  private revision = 0

  constructor(
    private readonly state: JournalReducerState,
    private originalAcceptance?: (id: string) => AgentJournalCursor | undefined
  ) {
    this.lineage = new JournalInputLineageOwner(state.inputCards)
    this.cards = new JournalInputCardIndex(this.lineage)
  }

  withAcceptance<T>(read: (id: string) => AgentJournalCursor | undefined, run: () => T): T {
    const previous = this.originalAcceptance
    this.originalAcceptance = read
    try {
      return run()
    } finally {
      this.originalAcceptance = previous
    }
  }

  needsAcceptance(ids: readonly string[]): string[] {
    return journalInputsNeedingAcceptance(this.state, this.originals, ids)
  }
  acceptanceIdsSteps(): Generator<void, string[]> {
    return journalInputAcceptanceIdsSteps(this.state, this.originals)
  }

  beforeRow(state: JournalReducerState, row: JournalRow): void {
    this.receiptCount = state.receipts.size
    this.queueRevision = state.queue.revision
    if (prepareJournalInputRow(this, state, this.state, row, this.originalAcceptance)) {
      this.legacyPlaces++
    }
  }

  // A streaming prefix cannot establish the last legacy consumer.
  beginReconstruction(): void {
    finishJournalSteps(this.beginReconstructionSteps())
  }
  *beginReconstructionSteps(): Generator<void> {
    this.reconstructing = true
    this.legacyPlaces = 0
    for (const entry of this.state.inputEntries.values()) {
      if (entry.context.basis === 'legacy') {
        this.legacyPlaces++
      }
      yield
    }
  }
  finishReconstruction(state: JournalReducerState): void {
    finishJournalSteps(this.finishReconstructionSteps(state))
  }
  *finishReconstructionSteps(state: JournalReducerState): Generator<void> {
    this.legacyPlaces = yield* restoreJournalInputPlacesSteps(state, (id) =>
      this.originals.delete(id)
    )
    this.reconstructing = false
    if (this.legacyPlaces === 0) {
      yield* this.releaseHistorySteps(state)
    }
  }

  restore(state: JournalReducerState): void {
    finishJournalSteps(this.restoreSteps(state))
  }
  *restoreSteps(state: JournalReducerState): Generator<void> {
    this.legacyPlaces = yield* restoreJournalInputPlacesSteps(state, (id) =>
      this.originals.delete(id)
    )
    yield* this.cards.ensureSteps(state)
    for (const id of state.submissions.keys()) {
      yield* this.refreshSteps(state, id)
      yield
    }
    yield* this.lineage.restoreFrontierSteps(state.lastSequence, state.inputEntries.values())
  }

  linkedVersion = (): number => this.links.version()
  linkedTo(id: string): Iterable<AgentJournalSubmission> {
    return this.links.to(id)
  }
  overlay(state: JournalReducerState, rows: readonly QueuedMessageRow[]): void {
    finishJournalSteps(this.overlaySteps(state, rows))
  }
  *overlaySteps(state: JournalReducerState, rows: readonly QueuedMessageRow[]): Generator<void> {
    yield* this.cards.overlaySteps(state, rows)
  }
  *introduceOverlaysSteps(state: JournalReducerState): Generator<void> {
    if (this.cards.hasUnintroduced()) {
      yield* this.cards.ensureSteps(state)
    }
    yield* this.cards.introduceOverlaysSteps((card) => this.queueChanged(state, undefined, card))
  }
  *prepareRowSteps(state: JournalReducerState, row: JournalRow): Generator<void> {
    if (
      row.kind === 'queue' ||
      (row.kind === 'submission' &&
        row.handoverRecorded &&
        row.queuedMessageId === undefined &&
        !state.inputEntries.has(row.clientMessageId))
    ) {
      yield* this.cards.ensureSteps(state)
    }
  }

  *markOpeningRecoverySteps(): Generator<void> {
    for (const entry of this.unsettled.values()) {
      if (isQueuedAgentJournalSubmission(entry)) {
        this.markRecoveryPending(entry.clientMessageId)
      }
      yield
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
  *carryRecoverySteps(previous: JournalInputOrder): Generator<void> {
    for (const id of previous.recoveryOwed) {
      if (this.queued.has(id)) {
        this.markRecoveryPending(id)
      }
      yield
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
    refreshJournalInputRow(state, row, (id) => finishJournalSteps(this.refreshSteps(state, id)))
  }

  private *refreshSteps(state: JournalReducerState, id: string): Generator<void> {
    const entry = state.submissions.get(id)
    this.links.refresh(id, entry, state.items)
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
    if (entry?.dispatchState !== 'pending' && !this.reconstructing) {
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
        yield* this.cards.indexCardSteps(state, card)
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
    finishJournalSteps(this.releaseHistorySteps(state))
  }
  private *releaseHistorySteps(state: JournalReducerState): Generator<void> {
    yield* this.lineage.releaseHistorySteps((id) => this.currentIdentity(state, id))
    this.cards.releaseHistory()
  }

  precedes(card: QueuedMessageRow, submission: AgentJournalSubmission): boolean {
    const place = this.place(submission.clientMessageId)
    return Boolean(place?.witnessCardId && this.cards.relation(card, place))
  }
}
