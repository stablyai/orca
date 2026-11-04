import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalSubmissionRow } from './journal-row-schema'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order'
import type { QueuedMessageRow } from './queued-message-table'
import {
  queuePauseHolding,
  journalQueueStopHolds,
  failedQueueTurnSequence,
  type DerivedQueuePause
} from './queued-message-pause'
import {
  JournalInputPlaceIndex,
  mergeInputPlaces,
  type InputPlaceQuery
} from './journal-input-place-index'
import type { JournalInputLineageOwner } from './journal-input-lineage'
import { isLiveJournalQueueCard } from './journal-queue-retention'
import { JournalInputDomainIndex, type JournalIndexedInputCard } from './journal-input-domain-index'
import { JournalInputCandidates } from './journal-input-candidates'
import { JournalInputReleasedPositions } from './journal-input-released-positions'
import {
  readJournalInputAdmission as readAdmission,
  queryJournalInputCurrent as queryCurrentPlace,
  journalInputCardPrecedes,
  gateJournalInputPlaces as gatePlaces,
  sameJournalInputCardPlace,
  type JournalInputPlace
} from './journal-input-order-state'

export class JournalInputCardIndex {
  private index: JournalInputPlaceIndex | undefined
  private currentCoordinates: JournalInputPlaceIndex | undefined
  private domains = new JournalInputDomainIndex()
  private readonly released = new JournalInputReleasedPositions()
  private history = true
  private readonly current = new Map<string, QueuedMessageRow>()
  private readonly positions = new JournalInputPlaceIndex('')
  private currentRevision = 0
  private readonly indexed = new Map<string, JournalIndexedInputCard>()
  readonly candidates = new JournalInputCandidates()
  // Derived current membership only; the prepared transition owns introduction values.
  private readonly unintroduced = new Set<string>()
  private overlayRows: readonly QueuedMessageRow[] = []
  private overlays = new Map<string, QueuedMessageRow>()
  overlay(state: JournalReducerState, rows: readonly QueuedMessageRow[]): void {
    if (rows === this.overlayRows || (rows.length === 0 && this.overlays.size === 0)) {
      return
    }
    this.ensure(state)
    const next = new Map(rows.map((card) => [card.messageId, card]))
    for (const card of this.overlays.values()) {
      if (!next.has(card.messageId) && !state.queue.cards.has(card.messageId)) {
        this.indexCard(state, { ...card, state: 'withdrawn' })
        this.positions.delete(card.messageId)
        this.unintroduced.delete(card.messageId)
      }
    }
    this.overlayRows = rows
    this.overlays = next
    for (const card of rows) {
      if (!state.queue.cards.has(card.messageId)) {
        if (!this.lineage.cards.has(card.messageId)) {
          this.unintroduced.add(card.messageId)
        }
        this.indexCard(state, card)
      }
    }
  }
  introduceOverlays(change: (card: QueuedMessageRow) => void): void {
    for (const id of this.unintroduced) {
      change(this.overlays.get(id)!)
    }
    this.unintroduced.clear()
  }
  private pauseKey: readonly unknown[] = []
  private floor: { epoch: string; sequence: number } | null = null
  private pauses: readonly DerivedQueuePause[] = []
  private cleared = new Set<string>()
  // A failure holds every waiting card alike, so it gates reads instead of the cached flags.
  private failed = false
  constructor(private readonly lineage: JournalInputLineageOwner) {}
  hasOverlay(id: string): boolean {
    return this.overlays.has(id)
  }
  /** Whether a failed turn holds waiting input, as of the last ensure. */
  failureHolds(): boolean {
    return this.failed
  }
  command(): QueuedMessageRow | undefined {
    return this.failed ? undefined : this.currentCoordinates?.allPlaces().command
  }
  releaseHistory(): void {
    this.history = false
    this.domains = new JournalInputDomainIndex()
    for (const card of this.current.values()) {
      const prior = this.indexed.get(card.messageId)
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
      (this.failed ||
        this.cleared.has(card.messageId) ||
        Boolean(queuePauseHolding(this.pauses, card)))
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

  queryCurrent(place: JournalInputPlace): InputPlaceQuery {
    return gatePlaces(queryCurrentPlace(place, this.currentCoordinates!), this.failed)
  }

  query(place: JournalInputPlace): InputPlaceQuery {
    const current =
      place.context.basis === 'observed'
        ? this.index!.query('introduction', place.context.cut)
        : this.domains.query(place.context, place.original)
    return gatePlaces(mergeInputPlaces(current, this.released.query(place)), this.failed)
  }

  ensure(state: JournalReducerState, floor?: { epoch: string; sequence: number } | null): void {
    if (floor !== undefined) {
      this.floor = floor
    }
    const marks = state.queuePauseMarks
    this.failed =
      failedQueueTurnSequence(
        journalInputOrder(state).newestTurn.failure(),
        marks.resumedSequence
      ) > 0
    const lifted = Math.max(state.latestAcceptedTurnSequence, marks.resumedSequence)
    const reopened = Math.max(
      marks.reopenedSequence,
      this.floor?.epoch === state.epoch ? this.floor.sequence : 0
    )
    const pauseInputs = [
      journalQueueStopHolds(marks, state.latestAcceptedTurnSequence) ? marks.latestStop : null,
      reopened > lifted ? reopened : 0,
      marks.cleared && !marks.cleared.lifted && marks.cleared.sequence > lifted
        ? marks.cleared
        : null
    ]
    const first = !this.index
    if (first || pauseInputs.some((value, i) => value !== this.pauseKey[i])) {
      this.pauseKey = pauseInputs
      this.cleared = new Set(pauseInputs[2] ? marks.cleared?.messageIds : [])
      this.pauses = [
        ...(pauseInputs[0] && marks.latestStop
          ? [
              {
                reason: 'stopped' as const,
                since: { epoch: state.epoch, sequence: marks.latestStop.sequence }
              }
            ]
          : []),
        ...(pauseInputs[1]
          ? [{ reason: 'restarted' as const, since: { epoch: state.epoch, sequence: reopened } }]
          : [])
      ]
      if (first) {
        this.index = new JournalInputPlaceIndex('introduction')
        this.currentCoordinates = new JournalInputPlaceIndex(state.epoch)
        for (const card of this.overlays.values()) {
          if (!state.queue.cards.has(card.messageId)) {
            this.indexCard(state, card)
          }
        }
        for (const card of state.queue.cards.values()) {
          this.indexCard(state, card)
        }
      } else {
        this.currentRevision++
        this.released.pause(this.lineage.at(state.lastSequence))
        for (const card of this.current.values()) {
          this.indexCard(state, card)
        }
      }
    }
  }

  version(): number {
    return this.currentRevision
  }
  live(): Iterable<QueuedMessageRow> {
    return this.current.values()
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
    this.history = keepHistory
    this.refreshCurrent(state, card)
    if (prior && sameJournalInputCardPlace(prior, card)) {
      return
    }
    this.lineage.change(card.messageId, card.queuedAt, state.lastSequence)
    this.indexCard(state, card)
  }

  private refreshCurrent(state: JournalReducerState, card: QueuedMessageRow): void {
    if (isLiveJournalQueueCard(card, state.submissions)) {
      if (this.current.get(card.messageId) !== card) {
        this.current.set(card.messageId, card)
        this.currentRevision++
      }
    } else if (this.current.delete(card.messageId)) {
      this.currentRevision++
    }
  }

  indexCard(state: JournalReducerState, card: QueuedMessageRow): void {
    const prior = this.indexed.get(card.messageId)
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
    const cleared = this.cleared.has(card.messageId)
    const actionable =
      !cleared &&
      card.state === 'waiting' &&
      card.holdReason === null &&
      !queuePauseHolding(this.pauses, card)
    const handoff = attempt !== undefined && isQueuedAgentJournalSubmission(attempt)
    const known = this.lineage.cards.get(card.messageId)
    const lineage = known ?? {
      introduced: this.lineage.at(state.lastSequence),
      baseline: { coordinate: card.queuedAt }
    }
    const released = !known && !this.current.has(card.messageId)
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
      if (lineage.baseline && (this.history || !known)) {
        this.domains.set(card, lineage, actionable, handoff)
      }
    }
    if (card.state === 'withdrawn') {
      this.indexed.delete(card.messageId)
      return
    }
    this.indexed.set(card.messageId, {
      card,
      actionable,
      handoff,
      source: lineage,
      released
    })
  }

  releaseCard(id: string, sequence: number): void {
    const prior = this.indexed.get(id)
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
    this.indexed.set(id, { ...prior, source, released: true, releasedAt })
  }

  relation(card: QueuedMessageRow, place: JournalInputPlace): boolean {
    const lineage =
      this.lineage.cards.get(card.messageId) ?? this.indexed.get(card.messageId)?.source
    return journalInputCardPrecedes(lineage, place)
  }
}
