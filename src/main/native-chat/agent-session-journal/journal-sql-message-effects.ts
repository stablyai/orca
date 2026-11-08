import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalSubmission,
  AgentJournalAcceptanceReceipt
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalItemRow } from './durable-rows/journal-row-schema'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { journalDispatchRowApplies } from './projection/journal-dispatch-settlement'
import { readJournalDomainQueueRow } from './journal-domain-queue-rows'
import {
  journalDomainEditLeaseDeadline,
  retireJournalDomainEditHolds
} from './journal-domain-edit-leases'

export function acceptJournalSqlMessageEcho(
  db: Database.Database,
  prefix: readonly [string, string],
  rawId: string,
  itemId: string,
  row: JournalItemRow,
  submission?: AgentJournalSubmission
): AgentJournalAcceptanceReceipt | undefined {
  if (!submission) {
    const stored = db
      .prepare(`SELECT payload_json FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND item_id=? AND current=1`)
      .get(...prefix, itemId)
    submission = stored ? JSON.parse(String(stored.payload_json)) : undefined
  }
  if (!submission || !journalDispatchRowApplies(submission)) {
    return undefined
  }
  const accepted: AgentJournalSubmission = {
    ...submission,
    fence: row.fence,
    dispatchState: 'accepted',
    providerItemId: rawId,
    reason: null,
    resolvedAt: row.ts
  }
  delete accepted.recovered
  db.prepare(`UPDATE journal_submission_attempts SET dispatch_state='accepted',candidate=0,payload_json=?
    WHERE session_id=? AND epoch=? AND message_id=? AND current=1`).run(
    JSON.stringify(accepted),
    ...prefix,
    accepted.clientMessageId
  )
  const receipt: AgentJournalAcceptanceReceipt = {
    clientMessageId: accepted.clientMessageId,
    providerItemId: rawId,
    cursor: { epoch: row.epoch, sequence: row.seq },
    acceptedAt: row.ts
  }
  db.prepare(`INSERT INTO journal_send_receipts(session_id,epoch,message_id,payload_json) VALUES(?,?,?,?)
    ON CONFLICT(session_id,epoch,message_id) DO UPDATE SET payload_json=excluded.payload_json`).run(
    ...prefix,
    accepted.clientMessageId,
    JSON.stringify(receipt)
  )
  return receipt
}

/** Spends returned commands whose reported turn is saved, in place on their current rows. */
export function spendJournalSqlCommandCards(
  db: Database.Database,
  prefix: readonly [string, string],
  savedAt: number
): { cards: QueuedMessageRow[]; editDeadline?: number | null } {
  const target = { sessionId: prefix[0], epoch: prefix[1] }
  const cards = db
    .prepare(`UPDATE journal_queue_cards AS card SET state='withdrawn', revision=revision+1,
      command_turn_item_id=NULL
    WHERE session_id=? AND epoch=? AND state='returned' AND EXISTS(SELECT 1 FROM journal_items AS item
      WHERE item.session_id=card.session_id AND item.epoch=card.epoch AND item.item_id=card.command_turn_item_id)
    RETURNING message_id, revision, state, position, payload_json`)
    .all(...prefix)
    .map((row) => readJournalDomainQueueRow(target.sessionId, row).card)
  return retireJournalDomainEditHolds(
    db,
    target,
    cards.map((card) => card.messageId)
  )
    ? { cards, editDeadline: journalDomainEditLeaseDeadline(db, target, savedAt) }
    : { cards }
}
