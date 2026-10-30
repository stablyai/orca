import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { QueuedMessageRow } from './queued-message-table'
import { deriveQueuePauses, queuePauseHolding } from './queued-message-pause'

/** Replay reconstructs the queue place of direct inputs; publication never establishes that place. */
export class JournalInputOrder {
  private readonly prefixes = new Map<string, readonly QueuedMessageRow[]>()
  private pending: readonly AgentJournalSubmission[] = []
  private receiptCount = 0
  private queueRevision = 0
  private revision = 0

  constructor(
    private readonly originalAcceptance?: (id: string) => AgentJournalCursor | undefined
  ) {}

  beforeRow(state: JournalReducerState, row: JournalRow): void {
    this.receiptCount = state.receipts.size
    this.queueRevision = state.queue.revision
    if (row.kind !== 'submission' || !row.handoverRecorded || row.queuedMessageId !== undefined) {
      return
    }
    const cards = [...state.queue.cards.values()].sort((a, b) => a.position - b.position)
    const pauses = deriveQueuePauses({
      epoch: state.epoch,
      marks: state.queuePauseMarks,
      latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
      cards,
      reopenFloor: null
    })
    const prefix = cards.filter(
      (card) =>
        card.state === 'waiting' && card.holdReason === null && !queuePauseHolding(pauses, card)
    )
    const original = prefix.some((card) => card.queuedAt?.epoch !== state.epoch)
      ? this.originalAcceptance?.(row.clientMessageId)
      : undefined
    const earlier = prefix.filter((card) => {
      if (card.queuedAt?.epoch === state.epoch) {
        return card.queuedAt.sequence < row.seq
      }
      if (original?.epoch === state.epoch) {
        return true
      }
      return (
        card.queuedAt !== null &&
        original?.epoch === card.queuedAt.epoch &&
        card.queuedAt.sequence < original.sequence
      )
    })
    if (earlier.some((card) => card.body.command !== undefined)) {
      this.prefixes.set(row.clientMessageId, earlier)
    }
  }

  prefix(id: string): readonly QueuedMessageRow[] {
    return this.prefixes.get(id) ?? []
  }

  unsettledSubmissions(): readonly AgentJournalSubmission[] {
    return this.pending
  }

  version(): number {
    return this.revision
  }

  afterRow(state: JournalReducerState, row: JournalRow): void {
    if (
      row.kind === 'submission' ||
      row.kind === 'dispatch' ||
      row.kind === 'tombstone' ||
      this.receiptCount !== state.receipts.size ||
      this.queueRevision !== state.queue.revision
    ) {
      this.revision++
    }
    if (
      row.kind === 'submission' ||
      row.kind === 'dispatch' ||
      row.kind === 'tombstone' ||
      this.receiptCount !== state.receipts.size
    ) {
      this.pending = [...state.submissions.values()].filter(
        (entry) => entry.dispatchState === 'pending' || entry.dispatchState === 'unknown'
      )
      for (const id of this.prefixes.keys()) {
        const submission = state.submissions.get(id)
        if (!submission || submission.dispatchState !== 'pending') {
          this.prefixes.delete(id)
        }
      }
    }
  }

  /** Linked automatic handoffs inherit their card's place; explicit Send is the existing override. */
  precedes(card: QueuedMessageRow, submission: AgentJournalSubmission): boolean {
    return this.prefix(submission.clientMessageId).some(
      (prior) => prior.messageId === card.messageId
    )
  }
}
