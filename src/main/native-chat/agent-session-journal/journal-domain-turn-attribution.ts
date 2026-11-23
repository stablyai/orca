import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalConnectorDelivery } from '../../../shared/agent-session/journal/agent-journal-bot-message-fields'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { connectorReplyTurnStamps } from '../../../shared/agent-session/journal/journal-connector-reply-turn'
import { journalTurnAnsweredMessages } from '../../../shared/agent-session/journal/journal-turn-answered-messages'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import { journalCanonicalItemId, journalVisibleItem } from './journal-sql-item-reads'
import type { JournalSqlScope } from './journal-sql-scope'

/** Whom a turn acts for rests on its opener and the deliveries it answered (connectorReplyTurnStamps).
 *  messages: those it answered (journalTurnAnsweredMessages). stamps and messages null: no turn
 *  row, so nothing is proven. */
export type JournalTurnAttribution = {
  cursor: AgentJournalCursor
  turnItemId: string | null
  opener: AgentJournalRenderItem | null
  stamps: AgentJournalConnectorDelivery[] | null
  messages: AgentJournalRenderItem[] | null
}

/** A turn's row, opener and steered sends, each found by index: work is the turn's own rows (every
 *  send steered into it, all needed to prove none was a delivery), never the chat's send history (an
 *  operation window scans every current send). `through`: the sequence its end was read at; a row
 *  written later is not the ended turn's. `stampsOnly`: opener and messages stay null. */
export function readJournalDomainTurnAttribution(
  scope: JournalSqlScope,
  turnId: string,
  through: number,
  stampsOnly?: true
): JournalTurnAttribution {
  const cursor = journalDomainContextHead(scope.db, scope)
  const ended = (item: AgentJournalRenderItem | null) =>
    item && item.sequence <= through ? item : null
  const row = ended(turnRow(scope, turnId, through))
  if (!row) {
    return { cursor, turnItemId: null, opener: null, stamps: null, messages: null }
  }
  const turn = readAgentJournalTurn(row.body)
  const opener = !turn
    ? row.body.kind === 'message' && row.body.role === 'user'
      ? row
      : null
    : turn.userItemId
      ? ended(
          journalVisibleItem(
            scope.db,
            scope.prefix,
            journalCanonicalItemId(scope.db, scope.prefix)(turn.userItemId)
          )
        )
      : null
  const sends = scope.db
    .prepare(`SELECT payload_json FROM journal_submission_attempts INDEXED BY journal_submission_steer
    WHERE session_id=? AND epoch=? AND current=1 AND steer_turn_item_id=?
    ORDER BY accepted_sequence,ordinal`)
    .all(...scope.prefix, row.itemId)
  const submissions = sends.map((send) =>
    scope.decode<AgentJournalSubmission>(scope.examined(send).payload_json)
  )
  const items = submissions.flatMap((submission) => {
    const key = agentJournalSubmissionKey(submission.clientMessageId)
    const item = ended(journalVisibleItem(scope.db, scope.prefix, key))
    return item ? [item] : []
  })
  const stamps = connectorReplyTurnStamps({ items, submissions }, opener, row.itemId)
  // Its caller checks only whom the turn answered: the rows stay in the worker.
  if (stampsOnly) {
    return { cursor, turnItemId: row.itemId, opener: null, stamps, messages: null }
  }
  return {
    cursor,
    turnItemId: row.itemId,
    opener,
    stamps,
    messages: journalTurnAnsweredMessages({ items, submissions }, opener, row.itemId)
  }
}

/** The turn's own root row: its lifecycle record by turn id, else the item the id names. */
function turnRow(
  scope: JournalSqlScope,
  turnId: string,
  through: number
): AgentJournalRenderItem | null {
  const named = scope.db
    .prepare(`SELECT item_id FROM journal_items INDEXED BY journal_items_named_turn
    WHERE session_id=? AND epoch=? AND turn_id=? AND hidden=0 AND root=1 AND sequence<=?
    ORDER BY sequence DESC, sequence_index DESC, ordinal DESC LIMIT 1`)
    .get(...scope.prefix, turnId, through)
  const item = journalVisibleItem(scope.db, scope.prefix, named ? String(named.item_id) : turnId)
  return item && isRootAgentJournalItem(item) ? item : null
}
