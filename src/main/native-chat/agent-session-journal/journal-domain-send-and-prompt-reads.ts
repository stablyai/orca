import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readJournalDomainSourceItems } from './journal-domain-source-items'
import type { JournalSqlScope } from './journal-sql-scope'
import { JOURNAL_ENDED_TURN_COUNTS } from './database/journal-ended-turn-counts'

/** The oldest or newest root prompt (a user message that is not a command). */
export function readJournalDomainPromptItem(
  scope: JournalSqlScope,
  end: 'first' | 'last'
): AgentJournalRenderItem | null {
  const order = end === 'first' ? 'ASC' : 'DESC'
  const row = scope.db
    .prepare(`SELECT payload_json FROM journal_items INDEXED BY journal_items_status_prompt
    WHERE session_id=? AND epoch=? AND hidden=0 AND prompt=1
    ORDER BY sequence ${order},sequence_index ${order},ordinal ${order} LIMIT 1`)
    .get(...scope.prefix)
  return row ? scope.decode<AgentJournalRenderItem>(scope.examined(row).payload_json) : null
}

/** The rows that mention an automation run (messages carrying it, its not-started cards), and the
 *  source items of the current sends whose saved body or card could carry it. */
export function readJournalDomainRunMentions(
  scope: JournalSqlScope,
  runId: string
): { items: AgentJournalRenderItem[]; sent: AgentJournalRenderItem[] } {
  const items = scope.db
    .prepare(`SELECT payload_json FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0
    AND ((kind='message' AND (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.body.automationRun.runId') END)=?)
      OR (kind='automation-run-not-started' AND (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.body.run.runId') END)=?))
    ORDER BY sequence,sequence_index,ordinal`)
    .all(...scope.prefix, runId, runId)
    .map((row) => scope.decode<AgentJournalRenderItem>(scope.examined(row).payload_json))
  const ids = scope.db
    .prepare(`SELECT message_id FROM journal_submission_attempts send
    WHERE session_id=? AND epoch=? AND current=1 AND (
      EXISTS(SELECT 1 FROM journal_submission_attempts attempt WHERE attempt.session_id=send.session_id
        AND attempt.epoch=send.epoch AND attempt.message_id=send.message_id
        AND (CASE WHEN json_valid(attempt.admission_body_json) THEN json_extract(attempt.admission_body_json,'$.automationRun.runId') END)=?)
      OR EXISTS(SELECT 1 FROM journal_queue_cards card WHERE card.session_id=send.session_id
        AND card.epoch=send.epoch AND card.message_id=send.message_id
        AND (CASE WHEN json_valid(card.payload_json) THEN json_extract(card.payload_json,'$.body.automationRun.runId') END)=?))
    ORDER BY ordinal`)
    .all(...scope.prefix, runId, runId)
    .map((row) => String(scope.examined(row).message_id))
  const sent: AgentJournalRenderItem[] = []
  for (let offset = 0; offset < ids.length; offset += 128) {
    sent.push(...readJournalDomainSourceItems(scope, ids.slice(offset, offset + 128)))
  }
  return { items, sent }
}

/** Whether any turn row is running, has no end, or ended at or after `openedAt` (any turn when null). */
export function readJournalDomainTurnRanSince(
  scope: JournalSqlScope,
  openedAt: number | null
): boolean {
  return (
    scope.db
      .prepare(`SELECT 1 FROM journal_items INDEXED BY journal_items_kind
      WHERE session_id=? AND epoch=? AND hidden=0 AND kind='turn'
      AND (? IS NULL OR lifecycle_state IS 'running' OR turn_completed_at IS NULL OR turn_completed_at>=?)
      LIMIT 1`)
      .get(...scope.prefix, openedAt, openedAt) !== undefined
  )
}

/** How many of the chat's turns have ended (not clears, not the running one); a turn several marker
 *  rows carry (its turn row and a legacy status of it) counts once. One row from the counts the
 *  journal's writes keep; a file opened read-only without them is counted. */
export function readJournalDomainEndedTurnCount(scope: JournalSqlScope): number {
  if (!hasEndedTurnCounts(scope)) {
    const row = scope.db
      .prepare(`SELECT COUNT(DISTINCT turn_id) AS count FROM journal_items INDEXED BY journal_items_turn_marker
      WHERE session_id=? AND epoch=? AND hidden=0 AND turn_marker=1 AND context_clear=0
      AND lifecycle_state IS NOT 'running'`)
      .get(...scope.prefix)
    return Number(row?.count ?? 0)
  }
  const row = scope.db
    .prepare(`SELECT count FROM ${JOURNAL_ENDED_TURN_COUNTS} WHERE session_id=? AND epoch=?`)
    .get(...scope.prefix)
  return Number(row?.count ?? 0)
}

// Once a connection sees the counts they stay: nothing drops them.
const connectionsWithCounts = new WeakSet<object>()

function hasEndedTurnCounts(scope: JournalSqlScope): boolean {
  if (connectionsWithCounts.has(scope.db)) {
    return true
  }
  const found =
    scope.db
      .prepare(`SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?`)
      .get(JOURNAL_ENDED_TURN_COUNTS) !== undefined
  if (found) {
    connectionsWithCounts.add(scope.db)
  }
  return found
}

/** The newest accepted send whose provider id is this row id, or whose opener row it is; a null id
 *  matches a send with no provider id, as an equality over its fields does. */
export function readJournalDomainAcceptedSendOfRow(
  scope: JournalSqlScope,
  itemId: string | null
): AgentJournalSubmission | null {
  const row = scope.db
    .prepare(`SELECT payload_json FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND current=1 AND dispatch_state='accepted'
    AND (provider_item_id IS ? OR item_id IS ?) ORDER BY ordinal DESC LIMIT 1`)
    .get(...scope.prefix, itemId, itemId)
  return row ? scope.decode<AgentJournalSubmission>(scope.examined(row).payload_json) : null
}

/** Whether a current send carries this id as its own or as the queued card it took. */
export function readJournalDomainOperationSent(
  scope: JournalSqlScope,
  operationId: string
): boolean {
  return (
    scope.db
      .prepare(`SELECT 1 FROM journal_submission_attempts WHERE session_id=? AND epoch=? AND current=1
      AND (message_id=? OR (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.queuedMessageId') END)=?) LIMIT 1`)
      .get(...scope.prefix, operationId, operationId) !== undefined
  )
}

/** Each current send's message id and saved body fingerprint, in send order. */
export function readJournalDomainSendFingerprints(
  scope: JournalSqlScope
): { clientMessageId: string; fingerprint: string }[] {
  return scope.db
    .prepare(`SELECT message_id,fingerprint FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND current=1 ORDER BY ordinal`)
    .all(...scope.prefix)
    .map((row) => ({
      clientMessageId: String(scope.examined(row).message_id),
      fingerprint: String(row.fingerprint)
    }))
}
