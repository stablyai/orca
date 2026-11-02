import { orchestrationMailNotice } from '../../../shared/agent-session/agent-session-message-source'
import type { QueuedMessageRow } from './queued-message-table'

/** Mail whose owner cannot be confirmed now keeps its place without holding up the person's own cards
 *  behind it. Later mail stays behind it, so mail still goes oldest first; a held or returned card
 *  behind it still holds, as it would at the head. */
export function selectBesideHeldMail(
  cards: () => readonly QueuedMessageRow[],
  head: QueuedMessageRow | null,
  ready: (card: QueuedMessageRow) => boolean,
  unavailable?: (card: QueuedMessageRow) => boolean
): QueuedMessageRow | null {
  if (!head || !ready(head)) {
    return null
  }
  if (!unavailable?.(head)) {
    return head
  }
  const all = cards()
  const behind = all.slice(all.findIndex((card) => card.messageId === head.messageId) + 1)
  const next = behind.find(
    (card) =>
      (card.state === 'waiting' || card.state === 'returned') &&
      !orchestrationMailNotice(card.body.from)
  )
  return next && ready(next) ? next : null
}
