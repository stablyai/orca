import type { JournalInputCardFacts } from './journal-input-facts-storage'
import { journalInputCardPauseInputs, journalInputCardPauses } from './journal-input-card-pauses'
import type {
  JournalInputPlaceStorage,
  JournalInputDomainStorage,
  JournalInputReleasedStorage,
  JournalInputCandidateStorage,
  JournalIndexStorageFactory
} from './journal-index-storage'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalSubmissionRow } from './journal-row-schema'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order'
import type { QueuedMessageRow } from './queued-message-table'
import { queuePauseHolding, failedQueueTurnSequence } from './queued-message-pause'
import { mergeInputPlaces, type InputPlaceQuery } from './journal-input-place-index'
import type { JournalInputLineageOwner } from './journal-input-lineage'
import { isLiveJournalQueueCard } from './journal-queue-retention'
import { memoryJournalIndexStorage } from './journal-memory-index-storage'
import {
  readJournalInputAdmission as readAdmission,
  queryJournalInputCurrent as queryCurrentPlace,
  journalInputCardPrecedes,
  gateJournalInputPlaces as gatePlaces,
  sameJournalInputCardPlace,
  type JournalInputPlace
} from './journal-input-order-state'

export class JournalInputCardIndex {
  private readonly facts: JournalInputCardFacts
  private index: JournalInputPlaceStorage | undefined
  private currentCoordinates: JournalInputPlaceStorage | undefined
  private readonly domains: JournalInputDomainStorage
  private readonly released: JournalInputReleasedStorage
  private readonly positions: JournalInputPlaceStorage
  readonly candidates: JournalInputCandidateStorage
  // Derived current membership only; the prepared transition owns introduction values.
  overlay(state: JournalReducerState, rows: readonly QueuedMessageRow[]): void {
    if (rows === this.facts.overlayRows || (rows.length === 0 && this.facts.overlays.size === 0)) {
      return
    }
    this.ensure(state)
    const next = new Map(rows.map((card) => [card.messageId, card]))
    for (const card of this.facts.overlayCards()) {
      if (!next.has(card.messageId) && !state.queue.cards.has(card.messageId)) {
        this.indexCard(state, { ...card, state: 'withdrawn' })
        this.positions.delete(card.messageId)
        this.facts.unintroduced.delete(card.messageId)
      }
    }
    this.facts.overlayRows = rows
    this.facts.replaceOverlays(next)
    for (const card of rows) {
      if (!state.queue.cards.has(card.messageId)) {
        if (!this.lineage.cards.has(card.messageId)) {
          this.facts.unintroduced.add(card.messageId)
        }
        this.indexCard(state, card)
      }
    }
  }
  introduceOverlays(change: (card: QueuedMessageRow) => void): void {
    for (const id of this.facts.unintroducedIds()) {
      change(this.facts.overlays.get(id)!)
    }
    this.facts.unintroduced.clear()
  }
  // A failure holds every waiting card alike, so it gates reads instead of the cached flags.
  constructor(
    private readonly lineage: JournalInputLineageOwner,
    private readonly indexes: JournalIndexStorageFactory = memoryJournalIndexStorage
  ) {
    this.facts = indexes.cardFacts()
    if (this.facts.initialized) {
      this.index = indexes.place('card-introductions')
      this.currentCoordinates = indexes.place('card-coordinates')
    }
    this.domains = indexes.domain('cards')
    this.released = indexes.released('cards')
    this.positions = indexes.place('card-positions')
    this.candidates = indexes.candidates('cards')
  }
  hasOverlay(id: string): boolean {
    return this.facts.overlays.has(id)
  }
  /** Whether a failed turn holds waiting input, as of the last ensure. */
  failureHolds(): boolean {
    return this.facts.failed
  }
  command(): QueuedMessageRow | undefined {
    return this.facts.failed ? undefined : this.currentCoordinates?.allCommand()
  }
  releaseHistory(): void {
    this.facts.history = false
    this.domains.clear()
    for (const card of this.facts.currentCards()) {
      const prior = this.facts.indexed.get(card.messageId)
      if (!this.lineage.cards.has(card.messageId) && prior?.source.baseline) {
        this.domains.set(card, prior.source, prior.actionable, prior.handoff)
      }
    }
  }
  head(): QueuedMessageRow | undefined {
    return this.index?.allPlaces().head
  }
  paused(card: QueuedMessageRow): boolean {
    return (
      card.state === 'waiting' &&
      card.holdReason === null &&
      (this.facts.failed ||
        this.facts.cleared.has(card.messageId) ||
        Boolean(queuePauseHolding(this.facts.pauses, card)))
    )
  }
  admission(
    state: JournalReducerState,
    row: JournalSubmissionRow,
    originalAcceptance?: (id: string) => AgentJournalCursor | undefined
  ): JournalInputPlace {
    this.ensure(state)
    return readAdmission(row, this, this.lineage.at(row.seq), originalAcceptance)
  }

  queryCurrent(place: JournalInputPlace): Pick<InputPlaceQuery, 'command'> {
    return {
      command: this.facts.failed ? undefined : queryCurrentPlace(place, this.currentCoordinates!)
    }
  }

  query(place: JournalInputPlace): InputPlaceQuery {
    const current =
      place.context.basis === 'observed'
        ? this.index!.query('introduction', place.context.cut)
        : this.domains.query(place.context, place.original)
    return gatePlaces(mergeInputPlaces(current, this.released.query(place)), this.facts.failed)
  }

  ensure(state: JournalReducerState, floor?: { epoch: string; sequence: number } | null): void {
    if (floor !== undefined) {
      this.facts.floor = floor
    }
    const marks = state.queuePauseMarks
    this.facts.failed =
      failedQueueTurnSequence(
        journalInputOrder(state).newestTurn.failure(),
        marks.resumedSequence
      ) > 0
    const pauseInputs = journalInputCardPauseInputs(
      state.epoch,
      marks,
      state.latestAcceptedTurnSequence,
      this.facts.floor
    )
    const first = !this.facts.initialized
    if (first || !this.facts.pauseKeyMatches(pauseInputs)) {
      this.facts.pauseKey = pauseInputs
      this.facts.replaceClearMembers(pauseInputs[2] ? (marks.cleared?.messageIds ?? []) : [])
      this.facts.pauses = journalInputCardPauses(state.epoch, pauseInputs)
      if (first) {
        this.facts.initialized = true
        this.index = this.indexes.place('card-introductions')
        this.currentCoordinates = this.indexes.place('card-coordinates')
        for (const card of this.facts.overlayCards()) {
          if (!state.queue.cards.has(card.messageId)) {
            this.indexCard(state, card)
          }
        }
        for (const card of state.queries.queueCardsForInitialization(state)) {
          this.indexCard(state, card)
        }
      } else {
        this.facts.currentRevision++
        this.released.pause(this.lineage.at(state.lastSequence))
        for (const card of this.facts.currentCards()) {
          this.indexCard(state, card)
        }
      }
    }
  }

  version(): number {
    return this.facts.currentRevision
  }
  live(): Iterable<QueuedMessageRow> {
    return this.facts.currentCards()
  }
  bounds(): { first: number; last: number } {
    return {
      first: Math.min(0, this.positions.firstPosition()),
      last: Math.max(0, this.positions.allPlaces().position)
    }
  }

  queueChanged(
    state: JournalReducerState,
    prior: QueuedMessageRow | undefined,
    card: QueuedMessageRow,
    keepHistory: boolean
  ): void {
    this.ensure(state)
    this.facts.history = keepHistory
    this.refreshCurrent(state, card)
    if (prior && sameJournalInputCardPlace(prior, card)) {
      return
    }
    this.lineage.change(card.messageId, card.queuedAt, state.lastSequence)
    this.indexCard(state, card)
  }

  private refreshCurrent(state: JournalReducerState, card: QueuedMessageRow): void {
    if (isLiveJournalQueueCard(card, state.submissions)) {
      if (this.facts.current.get(card.messageId) !== card) {
        this.facts.current.set(card.messageId, card)
        this.facts.currentRevision++
      }
    } else if (this.facts.current.delete(card.messageId)) {
      this.facts.currentRevision++
    }
  }

  indexCard(state: JournalReducerState, card: QueuedMessageRow): void {
    const prior = this.facts.indexed.get(card.messageId)
    if (prior) {
      if (prior.released) {
        this.released.delete(prior)
      } else {
        this.domains.delete(prior.card, prior.source)
      }
    }
    this.refreshCurrent(state, card)
    this.positions.setPosition(card.messageId, card.position)
    const attempt = card.consumedAs ? state.submissions.get(card.consumedAs) : undefined
    const cleared = this.facts.cleared.has(card.messageId)
    const actionable =
      !cleared &&
      card.state === 'waiting' &&
      card.holdReason === null &&
      !queuePauseHolding(this.facts.pauses, card)
    const handoff = attempt !== undefined && isQueuedAgentJournalSubmission(attempt)
    const known = this.lineage.cards.get(card.messageId)
    const lineage = known ?? {
      introduced: this.lineage.at(state.lastSequence),
      baseline: { coordinate: card.queuedAt }
    }
    const released = !known && !this.facts.current.has(card.messageId)
    this.candidates.set(
      card,
      (card.state === 'waiting' && card.holdReason === null) || card.state === 'returned'
    )
    this.currentCoordinates!.set(card, actionable, handoff)
    if (released) {
      this.index!.delete(card.messageId)
      this.released.add(card, lineage)
    } else {
      this.index!.set(card, actionable, handoff, {
        epoch: 'introduction',
        sequence: lineage.introduced
      })
      if (lineage.baseline && (this.facts.history || !known)) {
        this.domains.set(card, lineage, actionable, handoff)
      }
    }
    if (card.state === 'withdrawn') {
      this.facts.indexed.delete(card.messageId)
      return
    }
    this.facts.indexed.set(card.messageId, {
      card,
      actionable,
      handoff,
      source: lineage,
      released
    })
  }

  releaseCard(id: string, sequence: number): void {
    const prior = this.facts.indexed.get(id)
    if (!prior || prior.released) {
      return
    }
    this.index!.delete(id)
    this.domains.delete(prior.card, prior.source)
    const source = {
      introduced: prior.source.introduced,
      baseline: { coordinate: prior.card.queuedAt }
    }
    const releasedAt = this.lineage.at(sequence)
    this.released.add(prior.card, source, releasedAt)
    this.facts.indexed.set(id, { ...prior, source, released: true, releasedAt })
  }

  relation(card: QueuedMessageRow, place: JournalInputPlace): boolean {
    const lineage =
      this.lineage.cards.get(card.messageId) ?? this.facts.indexed.get(card.messageId)?.source
    return journalInputCardPrecedes(lineage, place)
  }
}
