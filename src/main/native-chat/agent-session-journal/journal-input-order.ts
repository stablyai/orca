import { finishJournalSteps } from './journal-reconstruction-steps'
import * as inputState from './journal-input-order-state'
export type { JournalInputPlace } from './journal-input-order-state'

import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { JournalSubmissionIndex } from './journal-submission-index'
import { JournalNewestTurn } from './journal-newest-turn'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { QueuedMessageRow } from './queued-message-table'
import { JournalInputPlaces } from './journal-input-places'

export {
  initializeJournalInputOrder,
  initializeJournalInputOrderSteps,
  journalInputOrder,
  setJournalInputOrder
} from './journal-input-order-owner'

/** Own admission places and shared command witnesses are reconstructed by the journal fold. */
export class JournalInputOrder extends JournalInputPlaces {
  private reconstructing = false
  private legacyPlaces = 0
  private readonly recoveryOwed = new Set<string>()
  private readonly unsettled = new JournalSubmissionIndex()
  // Recovered unknown sends stay unsettled forever; only pending ones can still be accepted.
  private readonly sending = new JournalSubmissionIndex()
  private readonly queued = new Map<string, AgentJournalSubmission>()
  private readonly entered = new Map<string, AgentJournalSubmission>()
  private readonly overrides = new Map<string, AgentJournalSubmission>()
  private receiptCount = 0
  private queueRevision = 0
  private revision = 0

  constructor(
    state: JournalReducerState,
    originalAcceptance?: (id: string) => AgentJournalCursor | undefined,
    readonly newestTurn = new JournalNewestTurn(state)
  ) {
    super(state, originalAcceptance)
  }

  *prepareRowSteps(state: JournalReducerState, row: JournalRow): Generator<void> {
    yield* this.cards.ensureSteps(state)
    if (
      row.kind === 'submission' &&
      row.handoverRecorded &&
      row.queuedMessageId === undefined &&
      row.inputOrderContext?.basis !== 'observed'
    ) {
      yield
    }
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
    if (
      inputState.recordJournalInputAdmission(
        state,
        row,
        this.cards,
        this.originalAcceptance,
        (id) => this.releasePlace(state, id)
      )
    ) {
      this.legacyPlaces++
    }
  }

  // A streaming prefix cannot establish the last legacy consumer.
  beginReconstruction(): void {
    return finishJournalSteps(this.beginReconstructionSteps())
  }
  *beginReconstructionSteps(): Generator<void, void> {
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
    return finishJournalSteps(this.finishReconstructionSteps(state))
  }
  *finishReconstructionSteps(state: JournalReducerState): Generator<void, void> {
    this.reconstructing = false
    if (this.legacyPlaces === 0) {
      yield* this.releaseHistorySteps(state)
    }
  }

  restore(state: JournalReducerState): void {
    return finishJournalSteps(this.restoreSteps(state))
  }
  *restoreSteps(state: JournalReducerState): Generator<void, void> {
    this.legacyPlaces = yield* inputState.restoreJournalInputPlacesSteps(state)
    yield* this.cards.ensureSteps(state)
    for (const id of state.submissions.keys()) {
      this.refresh(state, id)
      yield
    }
    yield* this.lineage.restoreFrontierSteps(state.lastSequence, state.inputEntries.values())
  }

  overlay(state: JournalReducerState, rows: readonly QueuedMessageRow[]): void {
    return finishJournalSteps(this.overlaySteps(state, rows))
  }
  *overlaySteps(
    state: JournalReducerState,
    rows: readonly QueuedMessageRow[]
  ): Generator<void, void> {
    yield* this.cards.overlaySteps(state, rows)
  }
  introduceOverlays(state: JournalReducerState): void {
    return finishJournalSteps(this.introduceOverlaysSteps(state))
  }
  *introduceOverlaysSteps(state: JournalReducerState): Generator<void, void> {
    yield* this.cards.introduceOverlaysSteps((card) => this.queueChanged(state, undefined, card))
  }

  markOpeningRecovery(): void {
    return finishJournalSteps(this.markOpeningRecoverySteps())
  }
  *markOpeningRecoverySteps(): Generator<void, void> {
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
  carryRecovery(previous: JournalInputOrder): void {
    finishJournalSteps(this.carryRecoverySteps(previous))
  }
  *carryRecoverySteps(previous: JournalInputOrder): Generator<void> {
    for (const id of previous.recoveryOwed) {
      yield
      if (this.queued.has(id)) {
        this.markRecoveryPending(id)
      }
    }
  }

  forced(id: string): boolean {
    return this.state.inputEntries.get(id)?.witnessCardId !== undefined
  }
  hasQueuedSubmissions(): boolean {
    return this.queued.size > 0 || this.recoveryOwed.size > 0
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
  unsettledSubmissionCount = (): number => this.unsettled.size
  unsettledSubmissions(): readonly AgentJournalSubmission[] {
    return this.unsettled.list()
  }
  sendingSubmissionValues = this.sending.values.bind(this.sending)
  sendingSubmissions(): readonly AgentJournalSubmission[] {
    return this.sending.list()
  }
  version(): number {
    return this.revision
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

  afterRow(state: JournalReducerState, row: JournalRow): void {
    this.newestTurn.afterRow(state, row)
    if (inputState.journalInputOrderChanged(state, row, (key) => this[key])) {
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
    const id = this.inputIds.get(itemId)
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
      this.revision++
    }
    this.sending.keep(id, entry, dispatch === 'pending')
    if (dispatch !== 'pending') {
      this.releasePlace(state, id)
    }
    if (entry && isQueuedAgentJournalSubmission(entry)) {
      if (!this.recoveryOwed.has(id)) {
        this.queued.set(id, entry)
      }
      this.entered.delete(id)
      if (inputState.isJournalInputOverride(entry, this.recoveryOwed.has(id))) {
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
          this.cards.releaseCard(card.messageId, state.lastSequence)
          this.lineage.cards.delete(card.messageId)
        }
      }
    }
  }

  private currentIdentity(state: JournalReducerState, id: string): boolean {
    return inputState.currentJournalInputIdentity(state, id, () => this.cards.hasOverlay(id))
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
    yield* this.lineage.releaseHistorySteps((id) => {
      const keep = this.currentIdentity(state, id)
      if (!keep) {
        this.cards.releaseCard(id, state.lastSequence)
      }
      return keep
    })
    yield* this.cards.releaseHistorySteps()
  }
}
