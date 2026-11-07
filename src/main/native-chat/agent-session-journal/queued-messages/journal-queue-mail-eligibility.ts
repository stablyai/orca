import type { JournalSubmissionConsume } from '../journal-store-contracts'
import { QueuedMessageNotConsumableError } from './queued-message-consume-error'
import { orchestrationMailNotice } from '../../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import { journalInputOrder } from '../input-order/journal-input-order'
import type { JournalReducerState } from '../projection/journal-reducer'
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
  /** What else the cards past the head depend on: the queue's revision (any card's edit included)
   *  and its edit holds' version. */
  revisions: readonly unknown[]
  unavailable: ((card: QueuedMessageRow) => boolean) | undefined
  steer?: boolean
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
  if (input.steer) {
    if (!order.cards.candidates.hasMail()) {
      return null
    }
    const candidate = (card: QueuedMessageRow): 'mail' | 'pass' | 'stop' => {
      if (!ready(card)) {
        return 'stop'
      }
      return orchestrationMailNotice(card.body.from)
        ? 'mail'
        : card.body.command || card.body.from
          ? 'stop'
          : 'pass'
    }
    const first = candidate(head)
    const next =
      first === 'mail'
        ? head
        : first === 'stop'
          ? null
          : order.cards.candidates.pastHead(
              head,
              [...input.revisions, order.cards.failureHolds(), 'steer'],
              () => {
                for (const row of order.cards.candidates.after(head)) {
                  const card = get(row.messageId) ?? row
                  const kind = candidate(card)
                  if (kind !== 'pass') {
                    return kind === 'mail' ? card : null
                  }
                }
                return null
              }
            )
    return next && !input.unavailable?.(next) ? next : null
  }
  if (!orchestrationMailNotice(head.body.from) || !input.unavailable?.(head)) {
    return head
  }
  // What lies past it changes only with a card, a pause or an edit hold: walked once per change.
  return order.cards.candidates.pastHead(head, input.revisions, () => {
    for (const candidate of order.cards.candidates.after(head)) {
      const card = get(candidate.messageId) ?? candidate
      if (!ready(card)) {
        return null
      }
      if (!orchestrationMailNotice(card.body.from)) {
        return card
      }
    }
    return null
  })
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
