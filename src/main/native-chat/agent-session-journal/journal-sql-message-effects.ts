import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type {
  AgentJournalSubmission,
  AgentJournalAcceptanceReceipt
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalItemRow } from './durable-rows/journal-row-schema'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { journalDispatchRowApplies } from './projection/journal-dispatch-settlement'

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

export function spendJournalSqlCommandCards(
  db: Database.Database,
  prefix: readonly [string, string],
  sequence: number,
  returned: readonly SqliteRow[]
): QueuedMessageRow[] {
  const cards: QueuedMessageRow[] = []
  for (const row of returned) {
    const card: QueuedMessageRow = { ...JSON.parse(String(row.payload_json)), state: 'withdrawn' }
    db.prepare(
      `UPDATE journal_card_versions SET current=0 WHERE session_id=? AND epoch=? AND message_id=? AND current=1`
    ).run(...prefix, card.messageId)
    db.prepare(`INSERT INTO journal_card_versions(session_id,epoch,message_id,version_sequence,version_index,current,state,command_turn_item_id,payload_json)
      VALUES(?,?,?,?,0,1,'withdrawn',NULL,?)`).run(
      ...prefix,
      card.messageId,
      sequence,
      JSON.stringify(card)
    )
    cards.push(card)
  }
  return cards
}
