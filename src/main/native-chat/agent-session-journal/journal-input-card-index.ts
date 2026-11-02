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
import {
  JournalInputPlaceIndex,
  mergeInputPlaces,
  type InputPlaceQuery
} from './journal-input-place-index'
import { type JournalInputLineageOwner, queryInputContext } from './journal-input-lineage'
import { JournalInputRestamps, type JournalIndexedCard } from './journal-input-restamp'

export class JournalInputCardIndex {
  private index: JournalInputPlaceIndex | undefined
  private currentCoordinates: JournalInputPlaceIndex | undefined
  private readonly indexed = new Map<string, JournalIndexedCard>()
  private readonly restamps = new JournalInputRestamps()
  private rebuilding = false
  // Effective cards a queue pause can hold; a pause change re-flags only these.
  private readonly waiting = new Set<string>()
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
  constructor(private readonly lineage: JournalInputLineageOwner) {}
  hasOverlay(id: string): boolean {
    return this.overlays.has(id)
  }
  command(): QueuedMessageRow | undefined {
    return this.currentCoordinates?.allPlaces().command
  }
  releaseHistory(keep: (id: string) => boolean): void {
    this.lineage.releaseHistory((id) => {
      const kept = keep(id)
      if (!kept) {
        this.restamps.release(id)
      }
      return kept
    })
    this.restamps.releaseHistory()
  }
  release(id: string): void {
    this.lineage.cards.delete(id)
    this.restamps.release(id)
  }
  head(): QueuedMessageRow | undefined {
    return this.index && this.restamps.head(this.index)
  }
  paused(card: QueuedMessageRow): boolean {
    return (
      card.state === 'waiting' &&
      card.holdReason === null &&
      (this.cleared.has(card.messageId) || Boolean(queuePauseHolding(this.pauses, card)))
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
    return queryInputContext(
      place.context,
      place.original,
      (coordinate) => this.currentCoordinates!.query(coordinate.epoch, coordinate.sequence),
      () => this.currentCoordinates!.allPlaces(),
      mergeInputPlaces
    )
  }

  query(place: JournalInputPlace): InputPlaceQuery {
    return place.context.basis === 'observed'
      ? this.restamps.observed(this.index!, place.context.cut)
      : this.restamps.legacy(place, this.indexed, this.lineage.cards)
  }

  ensure(state: JournalReducerState, floor?: { epoch: string; sequence: number } | null): void {
    if (floor !== undefined) {
      this.floor = floor
    }
    floor = this.floor
    const marks = state.queuePauseMarks
    const lifted = Math.max(state.latestAcceptedTurnSequence, marks.resumedSequence)
    const reopened = Math.max(
      marks.reopenedSequence,
      floor?.epoch === state.epoch ? floor.sequence : 0
    )
    const failed = failedQueueTurnSequence(
      journalInputOrder(state).newestTurn.failure(),
      marks.resumedSequence
    )
    const pauseInputs = [
      journalQueueStopHolds(marks, state.latestAcceptedTurnSequence) ? marks.latestStop : null,
      reopened > lifted ? reopened : 0,
      marks.cleared && !marks.cleared.lifted && marks.cleared.sequence > lifted
        ? marks.cleared
        : null,
      failed
    ]
    if (!this.index || pauseInputs.some((value, i) => value !== this.pauseKey[i])) {
      if (pauseInputs[2] !== this.pauseKey[2]) {
        this.cleared = new Set(pauseInputs[2] ? marks.cleared?.messageIds : [])
      }
      this.pauseKey = pauseInputs
      const since = (sequence: number) => ({ epoch: state.epoch, sequence })
      this.pauses = [
        ...(pauseInputs[0] && marks.latestStop
          ? [{ reason: 'stopped' as const, since: since(marks.latestStop.sequence) }]
          : []),
        ...(failed ? [{ reason: 'failed' as const, since: since(failed) }] : []),
        ...(pauseInputs[1] ? [{ reason: 'restarted' as const, since: since(reopened) }] : [])
      ]
      this.restamps.restart(this.lineage.at(state.lastSequence))
      this.rebuilding = true
      try {
        this.rebuild(state)
      } finally {
        this.rebuilding = false
      }
    }
  }

  private rebuild(state: JournalReducerState): void {
    if (this.index) {
      // Withdrawn, returned, dispatched and per-card-held cards keep their summaries.
      const changed: [QueuedMessageRow, boolean][] = []
      for (const id of this.waiting) {
        const card = state.queue.cards.get(id) ?? this.overlays.get(id)
        const actionable = card !== undefined && this.actionable(card)
        if (card && this.indexed.get(id)?.actionable !== actionable) {
          changed.push([card, actionable])
        }
      }
      for (const [card, actionable] of changed) {
        this.indexCard(state, card, actionable)
      }
      // Each card changed since the last rebuild takes the entry main's full rebuild gave it.
      for (const id of this.restamps.take()) {
        const card = state.queue.cards.get(id) ?? this.overlays.get(id)
        if (card) {
          this.indexCard(state, card, this.indexed.get(id)?.actionable ?? false)
        } else {
          this.restamps.unpath(id)
        }
      }
      return
    }
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
  }

  private actionable(card: QueuedMessageRow): boolean {
    return (
      !this.cleared.has(card.messageId) &&
      card.state === 'waiting' &&
      card.holdReason === null &&
      !queuePauseHolding(this.pauses, card)
    )
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

  indexCard(
    state: JournalReducerState,
    card: QueuedMessageRow,
    actionable = this.actionable(card)
  ): void {
    const attempt = card.consumedAs ? state.submissions.get(card.consumedAs) : undefined
    const handoff = attempt !== undefined && isQueuedAgentJournalSubmission(attempt)
    const id = card.messageId
    const owned = this.lineage.cards.get(id)
    const lineage = owned ?? {
      introduced: this.lineage.at(state.lastSequence),
      baseline: { coordinate: card.queuedAt }
    }
    this.currentCoordinates!.set(card, actionable, handoff)
    const entry = { card, actionable, handoff, ...(!owned ? { source: lineage } : {}) }
    const prior = this.indexed.get(id)
    const floored = this.restamps.place(this.index!, entry, lineage, this.rebuilding, prior)
    if (card.state === 'waiting' && card.holdReason === null) {
      this.waiting.add(card.messageId)
    } else {
      this.waiting.delete(card.messageId)
    }
    if (card.state === 'withdrawn') {
      this.indexed.delete(card.messageId)
      return
    }
    this.indexed.set(id, floored ? { ...entry, floored: true as const } : entry)
  }

  relation(card: QueuedMessageRow, place: JournalInputPlace): boolean {
    const lineage =
      this.lineage.cards.get(card.messageId) ??
      this.restamps.source(this.indexed.get(card.messageId))
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
