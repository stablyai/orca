import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalSubmissionRow } from './journal-row-schema'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session/requests/agent-session-queued-submission'
import type { JournalReducerState } from './journal-reducer'
import { journalInputOrder } from './journal-input-order'
import type { QueuedMessageRow } from './queued-message-table'
import type { JournalInputPlace } from './journal-input-order-state'
import {
  boundaryQueuePauses,
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
import {
  type JournalInputLineageOwner,
  type JournalInputCard,
  queryInputContext
} from './journal-input-lineage'
import { JournalInputDomainIndex } from './journal-input-domain-index'
import { JournalInputCandidates } from './journal-input-candidates'
import { orchestrationMailNotice } from '../../../shared/agent-session/agent-session-message-source'

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
    if (rows === this.overlayRows || (rows.length === 0 && this.overlays.size === 0)) {
      return
    }
    this.ensure(state)
    const next = new Map(rows.map((card) => [card.messageId, card]))
    for (const card of this.overlays.values()) {
      if (!next.has(card.messageId) && !state.queue.cards.has(card.messageId)) {
        this.indexCard(state, { ...card, state: 'withdrawn' })
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
  /** Held by the personal Stop alone: a card queued after that Stop may pass it. A failed turn holds all of them. */
  stopHeldOnly(card: QueuedMessageRow): boolean {
    const [stop, ...others] = this.pauses
    return (
      !this.failed &&
      stop?.reason === 'stopped' &&
      !this.cleared.has(card.messageId) &&
      queuePauseHolding([stop], card) !== undefined &&
      !queuePauseHolding(others, card)
    )
  }
  admission(
    state: JournalReducerState,
    row: JournalSubmissionRow,
    originalAcceptance?: (id: string) => AgentJournalCursor | undefined
  ): JournalInputPlace {
    this.ensure(state)
    const coordinate = { epoch: row.epoch, sequence: row.seq }
    const context = row.inputOrderContext ?? {
      source: coordinate,
      basis: 'legacy' as const,
      cut: this.lineage.at(row.seq)
    }
    const original =
      context.basis === 'legacy' ? originalAcceptance?.(row.clientMessageId) : undefined
    const place: JournalInputPlace = { coordinate, context, ...(original ? { original } : {}) }
    const exposed = row.inputOrderContext?.basis === 'legacy' ? this.command() : undefined
    const selected =
      row.inputOrderContext?.basis === 'legacy'
        ? exposed && this.relation(exposed, place)
          ? exposed
          : undefined
        : !row.inputOrderContext
          ? this.queryCurrent(place).command
          : this.query(place).command
    return { ...place, ...(selected ? { witnessCardId: selected.messageId } : {}) }
  }

  queryCurrent(place: JournalInputPlace): InputPlaceQuery {
    return this.gate(
      queryInputContext(
        place.context,
        place.original,
        (coordinate) => this.currentCoordinates!.query(coordinate.epoch, coordinate.sequence),
        () => this.currentCoordinates!.allPlaces(),
        mergeInputPlaces
      )
    )
  }

  query(place: JournalInputPlace): InputPlaceQuery {
    if (place.context.basis === 'observed') {
      return this.gate(this.index!.query('introduction', place.context.cut))
    }
    if (!this.domains) {
      this.domains = new JournalInputDomainIndex()
      for (const { card, source, actionable, handoff } of this.indexed.values()) {
        const known = this.lineage.cards.get(card.messageId) ?? source
        if (known) {
          this.domains.set(card, known, actionable, handoff)
        }
      }
    }
    return this.gate(this.domains.query(place.context, place.original))
  }

  private gate(result: InputPlaceQuery): InputPlaceQuery {
    if (!this.failed) {
      return result
    }
    const { head, handoff, position } = result
    return { ...(head ? { head } : {}), ...(handoff ? { handoff } : {}), position }
  }

  ensure(state: JournalReducerState, floor?: { epoch: string; sequence: number } | null): void {
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
    const stop = journalQueueStopHolds(marks) ? marks.latestStop : null
    const reopenHold = reopened > lifted ? reopened : 0
    const clearedHold =
      marks.cleared && !marks.cleared.lifted && marks.cleared.sequence > lifted
        ? marks.cleared
        : null
    const pauseInputs = [stop, reopenHold, clearedHold]
    if (!this.index || pauseInputs.some((value, i) => value !== this.pauseKey[i])) {
      this.pauseKey = pauseInputs
      this.cleared = new Set(clearedHold ? marks.cleared?.messageIds : [])
      this.index = new JournalInputPlaceIndex('introduction')
      this.currentCoordinates = new JournalInputPlaceIndex(state.epoch)
      this.domains = undefined
      this.indexed.clear()
      this.candidates.clear()
      this.pauses = boundaryQueuePauses({
        epoch: state.epoch,
        stop,
        reopened: reopenHold
      })
      for (const card of this.overlays.values()) {
        if (!state.queue.cards.has(card.messageId)) {
          this.indexCard(state, card)
        }
      }
      for (const card of state.queue.cards.values()) {
        this.indexCard(state, card)
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
      Boolean(prior.body.command) === Boolean(card.body.command) &&
      !!orchestrationMailNotice(prior.body.from) === !!orchestrationMailNotice(card.body.from)
    ) {
      return
    }
    this.lineage.change(card.messageId, card.queuedAt, state.lastSequence)
    this.indexCard(state, card)
  }

  indexCard(state: JournalReducerState, card: QueuedMessageRow): void {
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
    this.currentCoordinates!.set(card, actionable, handoff)
    this.index!.set(card, actionable, handoff, {
      epoch: 'introduction',
      sequence: lineage.introduced
    })
    if (this.domains && lineage) {
      this.domains.set(card, lineage, actionable, handoff)
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
    const lineage =
      this.lineage.cards.get(card.messageId) ?? this.indexed.get(card.messageId)?.source
    if (!lineage || lineage.introduced >= place.context.cut) {
      return false
    }
    if (place.context.basis === 'observed') {
      return true
    }
    if (!lineage.baseline) {
      return false
    }
    const coordinate = lineage.baseline.coordinate
    return queryInputContext(
      place.context,
      place.original,
      (boundary) => coordinate?.epoch === boundary.epoch && coordinate.sequence < boundary.sequence,
      () => true,
      (a, b) => a || b
    )
  }
}
