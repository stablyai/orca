import type {
  AgentJournalCursor,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { QueuedMessageRow } from './queued-message-table'
import { deriveQueuePauses, queuePauseHolding } from './queued-message-pause'

const EMPTY_PREFIX: readonly QueuedMessageRow[] = []

/** Replay reconstructs the queue place of direct inputs; publication never establishes that place. */
export class JournalInputOrder {
  private readonly prefixes = new Map<string, readonly QueuedMessageRow[]>()
  private readonly unsettled = new Map<string, AgentJournalSubmission>()
  private pending: readonly AgentJournalSubmission[] | undefined
  private readonly memberships = new WeakMap<readonly QueuedMessageRow[], ReadonlySet<string>>()
  private admissionContext:
    | {
        revision: number
        accepted: number
        stop: JournalReducerState['queuePauseMarks']['latestStop']
        resumed: number
        reopened: number
        cleared: JournalReducerState['queuePauseMarks']['cleared']
        cards: readonly QueuedMessageRow[]
        comparableThrough: number | null
        command: boolean
      }
    | undefined
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
    const marks = state.queuePauseMarks
    let context = this.admissionContext
    if (
      !context ||
      context.revision !== state.queue.revision ||
      context.accepted !== state.latestAcceptedTurnSequence ||
      context.stop !== marks.latestStop ||
      context.resumed !== marks.resumedSequence ||
      context.reopened !== marks.reopenedSequence ||
      context.cleared !== marks.cleared
    ) {
      const cards = [...state.queue.cards.values()].sort((a, b) => a.position - b.position)
      const pauses = deriveQueuePauses({
        epoch: state.epoch,
        marks,
        latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
        cards,
        reopenFloor: null
      })
      const eligible = cards.filter(
        (card) =>
          card.state === 'waiting' && card.holdReason === null && !queuePauseHolding(pauses, card)
      )
      const cached = context
      context = {
        revision: state.queue.revision,
        accepted: state.latestAcceptedTurnSequence,
        stop: marks.latestStop,
        resumed: marks.resumedSequence,
        reopened: marks.reopenedSequence,
        cleared: marks.cleared,
        cards:
          cached?.cards.length === eligible.length &&
          eligible.every((card, index) => card === cached.cards[index])
            ? cached.cards
            : eligible,
        comparableThrough: eligible.every((card) => card.queuedAt?.epoch === state.epoch)
          ? eligible.reduce((last, card) => Math.max(last, card.queuedAt?.sequence ?? 0), 0)
          : null,
        command: eligible.some((card) => card.body.command !== undefined)
      }
      this.admissionContext = context
    }
    const prefix = context.cards
    const original =
      context.comparableThrough === null
        ? this.originalAcceptance?.(row.clientMessageId)
        : undefined
    const comparable = (card: QueuedMessageRow): boolean => {
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
    }
    const unchanged = context.comparableThrough !== null && context.comparableThrough < row.seq
    const earlier = unchanged ? prefix : prefix.filter(comparable)
    if (unchanged ? context.command : earlier.some((card) => card.body.command !== undefined)) {
      this.prefixes.set(row.clientMessageId, earlier)
    }
  }

  prefix(id: string): readonly QueuedMessageRow[] {
    return this.prefixes.get(id) ?? EMPTY_PREFIX
  }

  unsettledSubmissions(): readonly AgentJournalSubmission[] {
    return (this.pending ??= [...this.unsettled.values()])
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
    if (this.queueRevision !== state.queue.revision) {
      this.admissionContext = undefined
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
    const identity = parseAgentJournalItemKey(itemId)
    if (identity?.provider === 'orca') {
      this.refresh(state, identity.clientMessageId)
    }
  }

  private refresh(state: JournalReducerState, id: string): void {
    const entry = state.submissions.get(id)
    if (entry?.dispatchState === 'pending' || entry?.dispatchState === 'unknown') {
      if (this.unsettled.get(id) !== entry) {
        this.unsettled.set(id, entry)
        this.pending = undefined
      }
    } else if (this.unsettled.delete(id)) {
      this.pending = undefined
    }
    if (entry?.dispatchState !== 'pending') {
      this.prefixes.delete(id)
    }
  }

  /** Linked automatic handoffs inherit their card's place; explicit Send is the existing override. */
  precedes(card: QueuedMessageRow, submission: AgentJournalSubmission): boolean {
    const prefix = this.prefix(submission.clientMessageId)
    let membership = this.memberships.get(prefix)
    if (!membership) {
      membership = new Set(prefix.map((prior) => prior.messageId))
      this.memberships.set(prefix, membership)
    }
    return membership.has(card.messageId)
  }
}
