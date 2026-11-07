import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { QueuedMessageRow } from '../queued-messages/queued-message-table'
import { isLiveJournalQueueCard } from '../queued-messages/journal-queue-retention'
import {
  deriveQueuePauses,
  queuePauseHolding,
  type DerivedQueuePause
} from '../queued-messages/queued-message-pause'
import { journalInputOrder } from './journal-input-order'

export function compareQueuedRows(a: QueuedMessageRow, b: QueuedMessageRow): number {
  return (
    a.position - b.position || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0)
  )
}

/** Current rows are the entire runtime order; dispatched slots stay reserved until withdrawal. */
export class JournalInputCardIndex {
  private initialized = false
  private readonly current = new Map<string, QueuedMessageRow>()
  private firstPosition = 0
  private lastPosition = 0
  private overlayRows: readonly QueuedMessageRow[] = []
  private overlays = new Map<string, QueuedMessageRow>()
  private revision = 0
  private ordered: { revision: number; rows: readonly QueuedMessageRow[] } | undefined
  private floor: AgentJournalCursor | null = null
  private pauseKey = ''
  private pauses: readonly DerivedQueuePause[] = []
  private failed = false

  overlay(state: JournalReducerState, rows: readonly QueuedMessageRow[]): void {
    if (rows === this.overlayRows) {
      return
    }
    this.ensure(state)
    const next = new Map(rows.map((row) => [row.messageId, row]))
    for (const card of this.overlays.values()) {
      if (!next.has(card.messageId) && !state.queue.cards.has(card.messageId)) {
        this.indexCard(state, { ...card, state: 'withdrawn' })
      }
    }
    this.overlayRows = rows
    this.overlays = next
    for (const card of rows) {
      if (!state.queue.cards.has(card.messageId)) {
        this.indexCard(state, card)
      }
    }
  }
  hasOverlay(id: string): boolean {
    return this.overlays.has(id)
  }
  ensure(state: JournalReducerState, floor?: AgentJournalCursor | null): void {
    if (floor !== undefined) {
      this.floor = floor
    }
    if (!this.initialized) {
      this.initialized = true
      for (const card of state.queue.cards.values()) {
        this.indexCard(state, card)
      }
    }
    const marks = state.queuePauseMarks
    const failedAt = journalInputOrder(state).newestTurn.failure()
    const key = [
      this.revision,
      state.latestAcceptedTurnSequence,
      journalInputOrder(state).latestPersonAcceptedSequence(),
      marks.latestStop?.sequence,
      marks.resumedSequence,
      marks.reopenedSequence,
      marks.cleared?.sequence,
      marks.cleared?.lifted,
      failedAt,
      this.floor?.epoch,
      this.floor?.sequence
    ].join(':')
    if (key !== this.pauseKey) {
      this.pauseKey = key
      this.pauses = deriveQueuePauses({
        epoch: state.epoch,
        marks,
        latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
        latestPersonAcceptedTurnSequence: journalInputOrder(state).latestPersonAcceptedSequence(),
        failedAt,
        cards: this.list(),
        reopenFloor: this.floor
      })
      this.failed = this.pauses.some((pause) => pause.reason === 'failed')
    }
  }
  failureHolds(): boolean {
    return this.failed
  }
  paused(card: QueuedMessageRow): boolean {
    return queuePauseHolding(this.pauses, card) !== undefined
  }
  head(): QueuedMessageRow | undefined {
    return this.list()[0]
  }
  version(): number {
    return this.revision
  }
  live(): Iterable<QueuedMessageRow> {
    return this.current.values()
  }
  list(): readonly QueuedMessageRow[] {
    if (this.ordered?.revision !== this.revision) {
      this.ordered = {
        revision: this.revision,
        rows: [...this.current.values()].sort(compareQueuedRows)
      }
    }
    return this.ordered.rows
  }
  bounds(): { first: number; last: number } {
    return { first: this.firstPosition, last: this.lastPosition }
  }
  indexCard(state: JournalReducerState, card: QueuedMessageRow): void {
    const prior = this.current.get(card.messageId)
    const live = isLiveJournalQueueCard(card, state.submissions)
    if (live && prior !== card) {
      this.current.set(card.messageId, card)
      this.revision++
    } else if (!live && this.current.delete(card.messageId)) {
      this.revision++
    }
    if (card.state !== 'withdrawn') {
      this.firstPosition = Math.min(this.firstPosition, card.position)
      this.lastPosition = Math.max(this.lastPosition, card.position)
    }
  }
}
