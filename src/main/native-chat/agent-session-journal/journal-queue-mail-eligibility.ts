import { orchestrationMailNotice } from '../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { journalInputOrder } from './journal-input-order'
import type { JournalReducerState } from './journal-reducer'
import type { QueuedMessageRow } from './queued-message-table'

/** The queue's one rule for what can be handed over next. The head goes unless it is mail whose owner
 *  cannot be confirmed now: that mail keeps its place, and the first of the person's cards behind it
 *  goes instead. Later mail stays behind it, so mail still goes oldest first. A returned, paused or
 *  edit-held card behind it is a barrier, as it is at the head; held cards are never candidates. It
 *  walks the live candidates only, never the epoch's dispatched or withdrawn cards. */
export function nextEligibleQueuedCard(input: {
  state: JournalReducerState
  floor: AgentJournalCursor | null
  /** Current values: selection reads identity summaries. */
  get: (messageId: string) => QueuedMessageRow | null
  editHeld: (messageId: string) => boolean
  unavailable: ((card: QueuedMessageRow) => boolean) | undefined
}): QueuedMessageRow | null {
  const { state, floor, get } = input
  const order = journalInputOrder(state)
  const identity = order.head(state, floor)
  const head = identity ? get(identity.messageId) : null
  const ready = (card: QueuedMessageRow) =>
    card.state !== 'returned' &&
    !order.paused(state, card, floor) &&
    !input.editHeld(card.messageId)
  if (!head || !ready(head)) {
    return null
  }
  if (!orchestrationMailNotice(head.body.from) || !input.unavailable?.(head)) {
    return head
  }
  for (const candidate of order.cards.after(head)) {
    const card = get(candidate.messageId) ?? candidate
    if (!ready(card)) {
      return null
    }
    if (!orchestrationMailNotice(card.body.from)) {
      return card
    }
  }
  return null
}
