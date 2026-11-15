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
import type { JournalInputCardFacts } from '../journal-input-facts-storage'
import type { JournalInputIndexStorage, JournalQueuedRowStorage } from '../journal-index-storage'
import { memoryJournalInputIndexStorage } from '../journal-memory-input-index-storage'
import type { JournalInputOrderResolver } from './journal-input-order-registry'

export { compareQueuedRows } from './journal-queued-row-index'

/** Current rows are the entire runtime order; dispatched slots stay reserved until withdrawal. */
export class JournalInputCardIndex {
  private readonly facts: JournalInputCardFacts
  private readonly current: JournalQueuedRowStorage
  // Rebuilt from the reducer's marks and the rows by each holder; never saved or exported.
  private readonly derived: {
    ordered?: { revision: number; rows: readonly QueuedMessageRow[] }
    pauseKey: string
    pauseContext?: QueuePauseContext
    clearIds?: readonly string[]
    clearMembers: ReadonlySet<string>
    failed: boolean
  } = { pauseKey: '', clearMembers: new Set(), failed: false }

  constructor(
    private readonly journalInputOrder: JournalInputOrderResolver,
    indexes: JournalInputIndexStorage = memoryJournalInputIndexStorage
  ) {
    this.facts = indexes.cardFacts()
    this.current = indexes.queuedRows('cards')
  }

  overlay(state: JournalReducerState, rows: readonly QueuedMessageRow[]): void {
    if (rows === this.facts.overlayRows || (rows.length === 0 && this.facts.overlays.size === 0)) {
      return
    }
    this.ensure(state)
    const next = new Map(rows.map((row) => [row.messageId, row]))
    for (const card of this.facts.overlayCards()) {
      if (!next.has(card.messageId) && !state.queue.cards.has(card.messageId)) {
        this.indexCard(state, { ...card, state: 'withdrawn' })
      }
    }
    this.facts.overlayRows = rows
    this.facts.replaceOverlays(next)
    for (const card of rows) {
      if (!state.queue.cards.has(card.messageId)) {
        this.indexCard(state, card)
      }
    }
  }
  /** A reopened chat has no host floor yet, as a fresh open's index. */
  reopen(): void {
    this.facts.floor = null
  }
  hasOverlay(id: string): boolean {
    return this.facts.overlays.has(id)
  }
  ensure(state: JournalReducerState, floor?: AgentJournalCursor | null): void {
    if (floor !== undefined) {
      this.facts.floor = floor
    }
    if (!this.facts.initialized) {
      this.facts.initialized = true
      for (const card of state.queries.queueCardsForInitialization(state)) {
        this.indexCard(state, card)
      }
    }
    const marks = state.queuePauseMarks
    const failedAt = this.journalInputOrder(state).newestTurn.failure()
    const reopenFloor = this.facts.floor
    const key = [
      state.latestAcceptedTurnSequence,
      this.journalInputOrder(state).latestPersonAcceptedSequence(),
      journalManualStop(marks)?.sequence,
      marks.resumedSequence,
      marks.reopenedSequence,
      marks.cleared?.sequence,
      marks.cleared?.lifted,
      failedAt,
      reopenFloor?.epoch,
      reopenFloor?.sequence
    ].join(':')
    const derived = this.derived
    const membershipChanged = marks.cleared?.messageIds !== derived.clearIds
    if (membershipChanged) {
      derived.clearIds = marks.cleared?.messageIds
      derived.clearMembers = new Set(derived.clearIds)
    }
    if (key !== derived.pauseKey || membershipChanged) {
      derived.pauseKey = key
      derived.pauseContext = createQueuePauseContext(
        {
          epoch: state.epoch,
          marks,
          latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
          latestPersonAcceptedTurnSequence:
            this.journalInputOrder(state).latestPersonAcceptedSequence(),
          failedAt,
          reopenFloor
        },
        derived.clearMembers
      )
      derived.failed = derived.pauseContext.pauses.some((pause) => pause.reason === 'failed')
    }
  }
  failureHolds(): boolean {
    return this.derived.failed
  }
  paused(card: QueuedMessageRow): boolean {
    const context = this.derived.pauseContext
    return context !== undefined && queuePauseHoldingInContext(context, card) !== undefined
  }
  head(): QueuedMessageRow | undefined {
    return this.current.head()
  }
  version(): number {
    return this.facts.revision
  }
  live(after?: QueuedMessageRow): Iterable<QueuedMessageRow> {
    return this.current.values(after)
  }
  list(): readonly QueuedMessageRow[] {
    const { revision } = this.facts
    if (this.derived.ordered?.revision !== revision) {
      this.derived.ordered = { revision, rows: [...this.current.values()] }
    }
    return this.derived.ordered.rows
  }
  bounds(): { first: number; last: number } {
    return { first: this.facts.firstPosition, last: this.facts.lastPosition }
  }
  indexCard(state: JournalReducerState, card: QueuedMessageRow): void {
    if (this.current.set(card, isLiveJournalQueueCard(card, state.submissions))) {
      this.facts.revision++
    }
    if (card.state !== 'withdrawn') {
      this.facts.firstPosition = Math.min(this.facts.firstPosition, card.position)
      this.facts.lastPosition = Math.max(this.facts.lastPosition, card.position)
    }
  }
}
