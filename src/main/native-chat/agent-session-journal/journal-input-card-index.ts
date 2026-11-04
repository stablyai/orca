import { finishJournalSteps } from './journal-reconstruction-steps'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalSubmissionRow } from './journal-row-schema'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order'
import type { QueuedMessageRow } from './queued-message-table'
import type { JournalInputPlace } from './journal-input-order-state'
import {
  queuePauseHolding,
  journalQueueStopHolds,
  failedQueueTurnSequence,
  type DerivedQueuePause
} from './queued-message-pause'
import { JournalInputPlaceIndex, type InputPlaceQuery } from './journal-input-place-index'
import {
  type JournalInputLineageOwner,
  type JournalInputCard,
  queryCurrentInputPlace,
  journalInputCardPrecedes,
  journalInputAdmission
} from './journal-input-lineage'
import { JournalInputDomainIndex } from './journal-input-domain-index'
import { JournalInputCandidates } from './journal-input-candidates'

export class JournalInputCardIndex {
  private index: JournalInputPlaceIndex | undefined
  private currentCoordinates: JournalInputPlaceIndex | undefined
  private domains: JournalInputDomainIndex | undefined
  private readonly indexed = new Map<
    string,
    {
      card: QueuedMessageRow
      actionable: boolean
      handoff: boolean
      source?: JournalInputCard
    }
  >()
  readonly candidates = new JournalInputCandidates()
  // Derived current membership only; the prepared transition owns introduction values.
  private readonly unintroduced = new Set<string>()
  private overlayRows: readonly QueuedMessageRow[] = []
  private overlays = new Map<string, QueuedMessageRow>()
  overlay(state: JournalReducerState, rows: readonly QueuedMessageRow[]): void {
    finishJournalSteps(this.overlaySteps(state, rows))
  }
  *overlaySteps(state: JournalReducerState, rows: readonly QueuedMessageRow[]): Generator<void> {
    if (rows === this.overlayRows || (rows.length === 0 && this.overlays.size === 0)) {
      return
    }
    yield* this.ensureSteps(state)
    const next = new Map<string, QueuedMessageRow>()
    for (const card of rows) {
      next.set(card.messageId, card)
      yield
    }
    for (const card of this.overlays.values()) {
      if (!next.has(card.messageId) && !state.queue.cards.has(card.messageId)) {
        yield* this.indexCardSteps(state, { ...card, state: 'withdrawn' })
        this.unintroduced.delete(card.messageId)
      }
      yield
    }
    this.overlayRows = rows
    this.overlays = next
    for (const card of rows) {
      if (!state.queue.cards.has(card.messageId)) {
        if (!this.lineage.cards.has(card.messageId)) {
          this.unintroduced.add(card.messageId)
        }
        yield* this.indexCardSteps(state, card)
      }
      yield
    }
  }
  hasUnintroduced(): boolean {
    return this.unintroduced.size !== 0
  }
  *introduceOverlaysSteps(change: (card: QueuedMessageRow) => void): Generator<void> {
    for (const id of this.unintroduced) {
      change(this.overlays.get(id)!)
      yield
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
    this.domains = undefined
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
    return journalInputAdmission(this, this.lineage, row, originalAcceptance)
  }

  queryCurrent(place: JournalInputPlace): InputPlaceQuery {
    return this.gate(queryCurrentInputPlace(this.currentCoordinates!, place))
  }

  query(place: JournalInputPlace): InputPlaceQuery {
    if (place.context.basis === 'observed') {
      return this.gate(this.index!.query('introduction', place.context.cut))
    }
    finishJournalSteps(this.prepareDomainsSteps())
    return this.gate(this.domains!.query(place.context, place.original))
  }

  *prepareDomainsSteps(): Generator<void> {
    if (!this.domains) {
      this.domains = new JournalInputDomainIndex()
      for (const { card, source, actionable, handoff } of this.indexed.values()) {
        const known = this.lineage.cards.get(card.messageId) ?? source
        if (known) {
          yield* this.domains.setSteps(card, known, actionable, handoff)
        }
        yield
      }
    }
  }

  private gate(result: InputPlaceQuery): InputPlaceQuery {
    if (!this.failed) {
      return result
    }
    const { head, handoff, position } = result
    return { ...(head ? { head } : {}), ...(handoff ? { handoff } : {}), position }
  }

  ensure(state: JournalReducerState, floor?: { epoch: string; sequence: number } | null): void {
    finishJournalSteps(this.ensureSteps(state, floor))
  }
  *ensureSteps(
    state: JournalReducerState,
    floor?: { epoch: string; sequence: number } | null
  ): Generator<void> {
    if (floor !== undefined) {
      this.floor = floor
    }
    floor = this.floor
    const marks = state.queuePauseMarks
    this.failed =
      failedQueueTurnSequence(
        journalInputOrder(state).newestTurn.failure(),
        marks.resumedSequence
      ) > 0
    const lifted = Math.max(state.latestAcceptedTurnSequence, marks.resumedSequence)
    const reopened = Math.max(
      marks.reopenedSequence,
      floor?.epoch === state.epoch ? floor.sequence : 0
    )
    const pauseInputs = [
      journalQueueStopHolds(marks, state.latestAcceptedTurnSequence) ? marks.latestStop : null,
      reopened > lifted ? reopened : 0,
      marks.cleared && !marks.cleared.lifted && marks.cleared.sequence > lifted
        ? marks.cleared
        : null
    ]
    if (!this.index || pauseInputs.some((value, i) => value !== this.pauseKey[i])) {
      this.pauseKey = pauseInputs
      this.cleared = new Set()
      if (pauseInputs[2]) {
        for (const id of marks.cleared?.messageIds ?? []) {
          this.cleared.add(id)
          yield
        }
      }
      this.index = new JournalInputPlaceIndex('introduction')
      this.currentCoordinates = new JournalInputPlaceIndex(state.epoch)
      this.domains = undefined
      this.indexed.clear()
      this.candidates.clear()
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
          ? [
              {
                reason: 'restarted' as const,
                since: { epoch: state.epoch, sequence: reopened }
              }
            ]
          : [])
      ]
      for (const card of this.overlays.values()) {
        if (!state.queue.cards.has(card.messageId)) {
          yield* this.indexCardSteps(state, card)
        }
        yield
      }
      for (const card of state.queue.cards.values()) {
        yield* this.indexCardSteps(state, card)
        yield
      }
    }
  }

  queueChanged(
    state: JournalReducerState,
    prior: QueuedMessageRow | undefined,
    card: QueuedMessageRow
  ): void {
    this.ensure(state)
    const sameCoordinate =
      prior?.queuedAt?.epoch === card.queuedAt?.epoch &&
      prior?.queuedAt?.sequence === card.queuedAt?.sequence
    if (
      prior &&
      prior.position === card.position &&
      prior.state === card.state &&
      prior.holdReason === card.holdReason &&
      prior.consumedAs === card.consumedAs &&
      sameCoordinate &&
      Boolean(prior.body.command) === Boolean(card.body.command)
    ) {
      return
    }
    this.lineage.change(card.messageId, card.queuedAt, state.lastSequence)
    this.indexCard(state, card)
  }

  indexCard(state: JournalReducerState, card: QueuedMessageRow): void {
    finishJournalSteps(this.indexCardSteps(state, card))
  }
  *indexCardSteps(state: JournalReducerState, card: QueuedMessageRow): Generator<void> {
    const attempt = card.consumedAs ? state.submissions.get(card.consumedAs) : undefined
    const cleared = this.cleared.has(card.messageId)
    const actionable =
      !cleared &&
      card.state === 'waiting' &&
      card.holdReason === null &&
      !queuePauseHolding(this.pauses, card)
    const handoff = attempt !== undefined && isQueuedAgentJournalSubmission(attempt)
    const lineage = this.lineage.cards.get(card.messageId) ?? {
      introduced: this.lineage.at(state.lastSequence),
      baseline: { coordinate: card.queuedAt }
    }
    this.candidates.set(
      card,
      (card.state === 'waiting' && card.holdReason === null) || card.state === 'returned'
    )
    yield* this.currentCoordinates!.setSteps(card, actionable, handoff)
    yield* this.index!.setSteps(card, actionable, handoff, {
      epoch: 'introduction',
      sequence: lineage.introduced
    })
    if (this.domains && lineage) {
      yield* this.domains.setSteps(card, lineage, actionable, handoff)
    }
    if (card.state === 'withdrawn') {
      this.indexed.delete(card.messageId)
      return
    }
    this.indexed.set(card.messageId, {
      card,
      actionable,
      handoff,
      ...(!this.lineage.cards.has(card.messageId) ? { source: lineage } : {})
    })
  }

  relation(card: QueuedMessageRow, place: JournalInputPlace): boolean {
    return journalInputCardPrecedes(
      this.lineage.cards.get(card.messageId) ?? this.indexed.get(card.messageId)?.source,
      place
    )
  }
}
