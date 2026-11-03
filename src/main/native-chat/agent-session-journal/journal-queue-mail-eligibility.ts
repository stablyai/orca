import { orchestrationMailNotice } from '../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalPastHead } from './journal-input-candidates'
import { journalInputOrder } from './journal-input-order'
import type { JournalReducerState } from './journal-reducer'
import type { QueuedMessageRow } from './queued-message-table'

/** The queue's one rule for what can be handed over next. The head goes unless it is mail whose owner
 *  cannot be confirmed now: that mail keeps its place, and the first of the person's cards behind it
 *  goes instead. Later mail stays behind it, so mail still goes oldest first. A card queued after the
 *  person's Stop passes cards held only by that Stop, and the walk stops at the first card that can go.
 *  A returned, otherwise paused or edit-held card behind it is a barrier, as it is at the head; held
 *  cards are never candidates. It walks the live candidates only, never the epoch's dispatched or
 *  withdrawn cards. */
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
}): QueuedMessageRow | null {
  const { state, floor, get } = input
  const order = journalInputOrder(state)
  const identity = order.head(state, floor)
  const head = identity ? get(identity.messageId) : null
  const ready = (card: QueuedMessageRow) =>
    card.state !== 'returned' &&
    !order.paused(state, card, floor) &&
    !input.editHeld(card.messageId)
  const mail = (card: QueuedMessageRow) => orchestrationMailNotice(card.body.from) !== null
  const passable = (card: QueuedMessageRow) =>
    order.cards.stopHeldOnly(card) && !input.editHeld(card.messageId)
  const headReady = head !== null && ready(head)
  if (!head || (!headReady && !passable(head))) {
    return null
  }
  if (headReady && (!mail(head) || !input.unavailable?.(head))) {
    return head
  }
  const walkAfter = (from: QueuedMessageRow, skipMail: boolean): JournalPastHead => {
    for (const candidate of order.cards.candidates.after(from)) {
      const card = get(candidate.messageId) ?? candidate
      if (!ready(card)) {
        if (!passable(card)) {
          return { first: null, person: null }
        }
        continue
      }
      if (skipMail && mail(card)) {
        continue
      }
      return skipMail
        ? { first: null, person: card }
        : { first: card, person: mail(card) ? null : card }
    }
    return { first: null, person: null }
  }
  // Failure is part of the key: a walk taken while a report runs must not be reused after it fails.
  const revisions = [...input.revisions, order.cards.failureHolds()]
  // Undecidable head mail keeps its place. Authority is asked every time; only the walk is kept.
  if (headReady) {
    return order.cards.candidates.pastHead(head, [...revisions, 'person'], () =>
      walkAfter(head, true)
    ).person
  }
  const past = order.cards.candidates.pastHead(head, revisions, () => walkAfter(head, false))
  const blocked = past.first
  if (!blocked || !mail(blocked) || !input.unavailable?.(blocked)) {
    return past.first
  }
  return order.cards.candidates.pastHead(blocked, [...revisions, 'person'], () =>
    walkAfter(blocked, true)
  ).person
}
