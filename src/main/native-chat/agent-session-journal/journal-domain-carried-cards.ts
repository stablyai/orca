// A connector message carries its conversation's returned cards into its own turn
// (external-conversation-returned-carry). Its admission's transaction hands each card to it, as
// Retry hands a card to its send, so none can run again.
import type Database from '../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import {
  journalDomainQueueRow,
  replaceJournalDomainQueueRow,
  type JournalDomainQueueRow
} from './journal-domain-queue-rows'
import { journalDomainMessageEditHeld } from './journal-domain-edit-leases'
import { repointJournalConnectorClaim } from './connector-replies/journal-connector-replies'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import type { JournalWriterCoordinate } from './journal-writer-effects'

type Target = { sessionId: string; epoch: string }

/** The cards the message names, each still returned with the content it was read with and no
 *  editor holding it; null when any changed since (a Retry, an edit, a delete), so its sender reads
 *  them again rather than send one twice. */
export function journalDomainCarriedCards(
  db: Database.Database,
  target: Target,
  body: AgentJournalMessageItem,
  now: number
): JournalDomainQueueRow[] | null {
  const rows: JournalDomainQueueRow[] = []
  for (const { messageId, fingerprint } of body.carriedCards ?? []) {
    const row = journalDomainQueueRow(db, target, messageId)
    if (
      row?.card.state !== 'returned' ||
      row.card.fingerprint !== fingerprint ||
      journalDomainMessageEditHeld(db, target, messageId, now)
    ) {
      return null
    }
    rows.push(row)
  }
  return rows
}

/** Each card is dispatched as the message, and the reply rows it claimed are the message's; written
 *  as one queue change ahead of the message's own. */
export function settleJournalDomainCarriedCards(
  db: Database.Database,
  target: Target,
  messageId: string,
  rows: readonly JournalDomainQueueRow[],
  activity: { fence: number; savedAt: number }
): { cards: QueuedMessageRow[]; coordinates: JournalWriterCoordinate[] } {
  if (rows.length === 0) {
    return { cards: [], coordinates: [] }
  }
  const cards = rows.map((prior) => {
    const card: QueuedMessageRow = {
      ...prior.card,
      state: 'dispatched',
      consumedAs: messageId,
      holdReason: null,
      returnedReason: null,
      returnedRejection: null
    }
    replaceJournalDomainQueueRow(db, target, prior, card)
    repointJournalConnectorClaim(db, target, card.messageId, messageId)
    return card
  })
  const head = db
    .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
    .get(target.sessionId, target.epoch)!
  const sequence = Number(head.last_sequence) + 1
  appendJournalSqlEvent(
    db,
    target,
    sequence,
    activity.savedAt,
    { items: [], submissions: [], cards: cards.map((card) => card.messageId) },
    { fence: activity.fence, observedAt: activity.savedAt }
  )
  return { cards, coordinates: [{ kind: 'queue', epoch: target.epoch, seq: sequence }] }
}
