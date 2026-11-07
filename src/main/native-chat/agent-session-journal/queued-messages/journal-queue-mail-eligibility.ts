import type { JournalSubmissionConsume } from '../journal-store-contracts'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'
import { orchestrationMailNotice } from '../../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { journalInputOrder } from '../input-order/journal-input-order'
import type { JournalReducerState } from '../projection/journal-reducer'
import type { QueuedMessageRow } from './queued-message-table'

type QueueWalk = { key: string; first: QueuedMessageRow | null; pastMail: QueuedMessageRow | null }
const walks = new WeakMap<object, QueueWalk[]>()

/** Automatic claim skips held rows; only an edit lease is a barrier. Mail keeps its owner's order. */
export function nextEligibleQueuedCard(input: {
  state: JournalReducerState
  floor: AgentJournalCursor | null
  get: (messageId: string) => QueuedMessageRow | null
  editHeld: (messageId: string) => boolean
  revisions: readonly unknown[]
  unavailable: ((card: QueuedMessageRow) => boolean) | undefined
  steer?: boolean
}): QueuedMessageRow | null {
  const order = journalInputOrder(input.state)
  order.cards.ensure(input.state, input.floor)
  const state = input.state
  const marks = state.queuePauseMarks
  const key = [
    ...input.revisions,
    order.version(),
    order.cards.version(),
    input.steer,
    order.cards.failureHolds(),
    state.latestAcceptedTurnSequence,
    journalInputOrder(state).latestPersonAcceptedSequence(),
    marks.latestStop?.sequence,
    marks.resumedSequence,
    marks.reopenedSequence,
    marks.cleared?.sequence,
    marks.cleared?.lifted,
    input.floor?.epoch,
    input.floor?.sequence
  ].join(':')
  const prior = walks.get(order.cards) ?? []
  let walk = prior.find((entry) => entry.key === key)
  if (!walk) {
    let first: QueuedMessageRow | null = null
    let pastMail: QueuedMessageRow | null = null
    for (const row of order.cards.list()) {
      const card = input.get(row.messageId) ?? row
      if (input.editHeld(card.messageId)) {
        break
      }
      if (card.state !== 'waiting' || card.holdReason !== null || order.cards.paused(card)) {
        continue
      }
      const mail = orchestrationMailNotice(card.body.from)
      if (input.steer && (card.body.command || (!mail && card.deliveryMode !== 'steer'))) {
        continue
      }
      if (!first) {
        first = card
        if (!mail) {
          break
        }
      } else if (!mail) {
        pastMail = card
        break
      }
    }
    walk = { key, first, pastMail }
    walks.set(order.cards, [walk, ...prior.slice(0, 1)])
  }
  const first = walk.first
  // Mail owedness is external to the journal: ask it afresh even when the row walk is memoized.
  return first && orchestrationMailNotice(first.body.from) && input.unavailable?.(first)
    ? walk.pastMail
    : first
}

/** Automatic consumption validates the same current selection on the journal write lane. */
export function assertQueuedCardConsumable(
  input: JournalSubmissionConsume & { consumedAs: string; fingerprint: string },
  card: QueuedMessageRow | null,
  next: () => QueuedMessageRow | null
): void {
  if (
    card !== null &&
    card.state === input.expect &&
    card.fingerprint === input.fingerprint &&
    input.consumedAs !== input.messageId &&
    (!input.yieldsToPause || next()?.messageId === input.messageId)
  ) {
    return
  }
  throw new QueuedMessageNotConsumableError(input.messageId, input.expect)
}
