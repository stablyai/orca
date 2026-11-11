import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { QueuedMessageRow } from '../queued-messages/queued-message-table'
import { isLiveJournalQueueCard } from '../queued-messages/journal-queue-retention'
import {
  createQueuePauseContext,
  queuePauseHoldingInContext,
  type QueuePauseContext
} from '../queued-messages/queued-message-pause'
import { journalManualStop } from '../queued-messages/queued-message-pause-marks'
import type { JournalInputOrderResolver } from './journal-input-order-registry'

import { JournalQueuedRowIndex } from './journal-queued-row-index'

/** Current rows are the entire runtime order; dispatched slots stay reserved until withdrawal. */
export class JournalInputCardIndex {
  private initialized = false
  private readonly current = new JournalQueuedRowIndex()
  private firstPosition = 0
  private lastPosition = 0
  private overlayRows: readonly QueuedMessageRow[] = []
  private overlays = new Map<string, QueuedMessageRow>()
  private revision = 0
  private ordered: { revision: number; rows: readonly QueuedMessageRow[] } | undefined
  private floor: AgentJournalCursor | null = null
  private pauseKey = ''
  private pauseContext: QueuePauseContext | undefined
  private clearIds: readonly string[] | undefined
  private clearMembers: ReadonlySet<string> = new Set()
  constructor(private readonly journalInputOrder: JournalInputOrderResolver) {}
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
    const failedAt = this.journalInputOrder(state).newestTurn.failure()
    const key = [
      state.latestAcceptedTurnSequence,
      this.journalInputOrder(state).latestPersonAcceptedSequence(),
      journalManualStop(marks)?.sequence,
      marks.resumedSequence,
      marks.reopenedSequence,
      marks.cleared?.sequence,
      marks.cleared?.lifted,
      failedAt,
      this.floor?.epoch,
      this.floor?.sequence
    ].join(':')
    const membershipChanged = marks.cleared?.messageIds !== this.clearIds
    if (membershipChanged) {
      this.clearIds = marks.cleared?.messageIds
      this.clearMembers = new Set(this.clearIds)
    }
    if (key !== this.pauseKey || membershipChanged) {
      this.pauseKey = key
      this.pauseContext = createQueuePauseContext(
        {
          epoch: state.epoch,
          marks,
          latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
          latestPersonAcceptedTurnSequence:
            this.journalInputOrder(state).latestPersonAcceptedSequence(),
          failedAt,
          reopenFloor: this.floor
        },
        this.clearMembers
      )
      this.failed = this.pauseContext.pauses.some((pause) => pause.reason === 'failed')
    }
  }
  failureHolds(): boolean {
    return this.failed
  }
  paused(card: QueuedMessageRow): boolean {
    return (
      this.pauseContext !== undefined &&
      queuePauseHoldingInContext(this.pauseContext, card) !== undefined
    )
  }
  head(): QueuedMessageRow | undefined {
    return this.current.head()
  }
  version(): number {
    return this.revision
  }
  live(after?: QueuedMessageRow): Iterable<QueuedMessageRow> {
    return this.current.values(after)
  }
  list(): readonly QueuedMessageRow[] {
    if (this.ordered?.revision !== this.revision) {
      this.ordered = {
        revision: this.revision,
        rows: [...this.current.values()]
      }
    }
    return this.ordered.rows
  }
  bounds(): { first: number; last: number } {
    return { first: this.firstPosition, last: this.lastPosition }
  }
  indexCard(state: JournalReducerState, card: QueuedMessageRow): void {
    if (this.current.set(card, isLiveJournalQueueCard(card, state.submissions))) {
      this.revision++
    }
    if (card.state !== 'withdrawn') {
      this.firstPosition = Math.min(this.firstPosition, card.position)
      this.lastPosition = Math.max(this.lastPosition, card.position)
    }
  }
}
