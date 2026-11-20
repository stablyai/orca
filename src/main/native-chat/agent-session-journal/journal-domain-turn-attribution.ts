import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalConnectorDelivery } from '../../../shared/agent-session/journal/agent-journal-bot-message-fields'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { connectorReplyTurnStamps } from '../../../shared/agent-session/journal/journal-connector-reply-turn'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import { journalCanonicalItemId, journalVisibleItem } from './journal-sql-item-reads'
import type { JournalSqlScope } from './journal-sql-scope'

/** Whom a turn acts for rests on its opener and the deliveries it answered (connectorReplyTurnStamps).
 *  stamps null: unknown (no turn row, or more steered sends than are read), so nothing is proven. */
export type JournalTurnAttribution = {
  cursor: AgentJournalCursor
  turnItemId: string | null
  opener: AgentJournalRenderItem | null
  stamps: AgentJournalConnectorDelivery[] | null
}

/** Steered sends read for one turn; past this the turn proves nothing. */
export const TURN_ATTRIBUTION_STEERED_CAP = 64

/** A turn's row, opener and steered sends, each found by index: work is the turn's own rows, never
 *  the chat's send history (an operation window scans every current send). */
export function readJournalDomainTurnAttribution(
  scope: JournalSqlScope,
  turnId: string
): JournalTurnAttribution {
  const cursor = journalDomainContextHead(scope.db, scope)
  const row = turnRow(scope, turnId)
  if (!row) {
    return { cursor, turnItemId: null, opener: null, stamps: null }
  }
  const turn = readAgentJournalTurn(row.body)
  const opener = !turn
    ? row.body.kind === 'message' && row.body.role === 'user'
      ? row
      : null
    : turn.userItemId
      ? journalVisibleItem(
          scope.db,
          scope.prefix,
          journalCanonicalItemId(scope.db, scope.prefix)(turn.userItemId)
        )
      : null
  const sends = scope.db
    .prepare(`SELECT payload_json FROM journal_submission_attempts INDEXED BY journal_submission_steer
    WHERE session_id=? AND epoch=? AND current=1 AND steer_turn_item_id=?
    ORDER BY accepted_sequence,ordinal LIMIT ?`)
    .all(...scope.prefix, row.itemId, TURN_ATTRIBUTION_STEERED_CAP + 1)
  if (sends.length > TURN_ATTRIBUTION_STEERED_CAP) {
    return { cursor, turnItemId: row.itemId, opener, stamps: null }
  }
  const submissions = sends.map((send) =>
    scope.decode<AgentJournalSubmission>(scope.examined(send).payload_json)
  )
  const items = submissions.flatMap((submission) => {
    const key = agentJournalSubmissionKey(submission.clientMessageId)
    const item = journalVisibleItem(scope.db, scope.prefix, key)
    return item ? [item] : []
  })
  return {
    cursor,
    turnItemId: row.itemId,
    opener,
    stamps: connectorReplyTurnStamps({ items, submissions }, opener, row.itemId)
  }
}

/** The turn's own root row: its lifecycle record by turn id, else the item the id names. */
function turnRow(scope: JournalSqlScope, turnId: string): AgentJournalRenderItem | null {
  const named = scope.db
    .prepare(`SELECT item_id FROM journal_items INDEXED BY journal_items_named_turn
    WHERE session_id=? AND epoch=? AND turn_id=? AND hidden=0
    ORDER BY sequence DESC, sequence_index DESC, ordinal DESC LIMIT 1`)
    .get(...scope.prefix, turnId)
  const item = journalVisibleItem(scope.db, scope.prefix, named ? String(named.item_id) : turnId)
  return item && isRootAgentJournalItem(item) ? item : null
}
