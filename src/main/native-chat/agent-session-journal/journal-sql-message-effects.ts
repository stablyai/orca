import type Database from '../../sqlite/sync-database'
import { advanceJournalDomainSubmissionRevision } from './journal-domain-submission-revision'
import { refreshJournalDomainAcceptedHandover } from './journal-domain-input-ends'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission,
  AgentJournalAcceptanceReceipt
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { isWriteFailureSubmission } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import type { JournalItemRow } from './durable-rows/journal-row-schema'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { journalDispatchRowApplies } from './projection/journal-dispatch-settlement'
import { readJournalDomainQueueRow } from './journal-domain-queue-rows'
import type { JournalDomainSubmissionStoredFacts } from './journal-domain-submission-records'
import {
  JOURNAL_DOMAIN_SUBMISSION_COLUMNS,
  journalDomainSubmissionColumns
} from './journal-domain-submission-columns'
import {
  journalDomainEditLeaseDeadline,
  retireJournalDomainEditHolds
} from './journal-domain-edit-leases'

export function matchJournalSqlMessageEcho(
  db: Database.Database,
  prefix: readonly [string, string],
  body: AgentJournalMessageItem,
  contextBoundary: number
): AgentJournalSubmission | undefined {
  const candidates = db
    .prepare(`SELECT attempt.payload_json FROM journal_submission_attempts AS attempt
      JOIN journal_items AS item ON item.session_id=attempt.session_id AND item.epoch=attempt.epoch AND item.item_id=attempt.item_id
      WHERE attempt.session_id=? AND attempt.epoch=? AND attempt.current=1 AND attempt.fingerprint=?
        AND attempt.dispatch_state<>'rejected'
        AND (?=0 OR COALESCE(attempt.accepted_sequence,0)>?)
        AND attempt.echo_observed=0
      ORDER BY attempt.submitted_at, attempt.ordinal`)
    .iterate(
      ...prefix,
      agentSessionSendBodyFingerprint(prefix[0], body),
      contextBoundary,
      contextBoundary
    )
  for (const candidate of candidates) {
    const submission: AgentJournalSubmission = JSON.parse(String(candidate.payload_json))
    if (!isWriteFailureSubmission(submission)) {
      return submission
    }
  }
  return undefined
}

export function acceptJournalSqlMessageEcho(
  db: Database.Database,
  prefix: readonly [string, string],
  rawId: string,
  itemId: string,
  row: JournalItemRow,
  submission?: AgentJournalSubmission
): AgentJournalAcceptanceReceipt | undefined {
  const stored = db
    .prepare(`SELECT payload_json,facts_json FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND item_id=? AND current=1`)
    .get(...prefix, itemId)
  if (!stored) {
    return undefined
  }
  const current: AgentJournalSubmission = submission ?? JSON.parse(String(stored.payload_json))
  const facts: JournalDomainSubmissionStoredFacts = JSON.parse(String(stored.facts_json))
  const retainedSource = facts.admission.sourcePlacement !== undefined
  if (!journalDispatchRowApplies(current)) {
    db.prepare(`UPDATE journal_submission_attempts SET echo_observed=1,
      admission_body_json=CASE WHEN ? THEN admission_body_json ELSE NULL END
      WHERE session_id=? AND epoch=? AND message_id=? AND current=1 AND echo_observed=0`).run(
      Number(retainedSource),
      ...prefix,
      current.clientMessageId
    )
    return undefined
  }
  const accepted: AgentJournalSubmission = {
    ...current,
    fence: row.fence,
    dispatchState: 'accepted',
    providerItemId: rawId,
    reason: null,
    resolvedAt: row.ts
  }
  delete accepted.recovered
  const payload = JSON.stringify(accepted)
  advanceJournalDomainSubmissionRevision(
    db,
    { sessionId: prefix[0], epoch: prefix[1] },
    accepted.clientMessageId,
    payload
  )
  db.prepare(`UPDATE journal_submission_attempts SET candidate=0,payload_json=?,
      ${JOURNAL_DOMAIN_SUBMISSION_COLUMNS.map((column) => `${column}=?`).join(',')},
      echo_observed=1,admission_body_json=CASE WHEN ? THEN admission_body_json ELSE NULL END
    WHERE session_id=? AND epoch=? AND message_id=? AND current=1`).run(
    payload,
    ...journalDomainSubmissionColumns(accepted, facts.carries),
    Number(retainedSource),
    ...prefix,
    accepted.clientMessageId
  )
  refreshJournalDomainAcceptedHandover(db, { sessionId: prefix[0], epoch: prefix[1] }, itemId)
  const receipt: AgentJournalAcceptanceReceipt = {
    clientMessageId: accepted.clientMessageId,
    providerItemId: rawId,
    cursor: { epoch: row.epoch, sequence: row.seq },
    acceptedAt: row.ts
  }
  db.prepare(`INSERT INTO journal_send_receipts(session_id,epoch,message_id,cursor_sequence,payload_json) VALUES(?,?,?,?,?)
    ON CONFLICT(session_id,epoch,message_id) DO UPDATE SET cursor_sequence=excluded.cursor_sequence,payload_json=excluded.payload_json`).run(
    ...prefix,
    accepted.clientMessageId,
    receipt.cursor.sequence,
    JSON.stringify(receipt)
  )
  return receipt
}

/** Spends returned commands whose reported turn is saved, in place on their current rows. */
export function spendJournalSqlCommandCards(
  db: Database.Database,
  prefix: readonly [string, string],
  savedAt: number,
  itemIds: readonly string[]
): { cards: QueuedMessageRow[]; editDeadline?: number | null } {
  const target = { sessionId: prefix[0], epoch: prefix[1] }
  const cards = db
    .prepare(`UPDATE journal_queue_cards AS card SET state='withdrawn', revision=revision+1,
      command_turn_item_id=NULL
    WHERE session_id=? AND epoch=? AND state='returned'
      AND command_turn_item_id IN (SELECT value FROM json_each(?)) AND EXISTS(SELECT 1 FROM journal_items AS item
      WHERE item.session_id=card.session_id AND item.epoch=card.epoch AND item.item_id=card.command_turn_item_id)
    RETURNING message_id, revision, state, position, payload_json`)
    .all(...prefix, JSON.stringify(itemIds))
    .map((row) => readJournalDomainQueueRow(target.sessionId, row).card)
  return retireJournalDomainEditHolds(
    db,
    target,
    cards.map((card) => card.messageId)
  )
    ? { cards, editDeadline: journalDomainEditLeaseDeadline(db, target, savedAt) }
    : { cards }
}
