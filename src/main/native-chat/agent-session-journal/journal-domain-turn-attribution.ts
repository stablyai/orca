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

/** The conversation a stamp-only attribution read asks about. */
export type JournalTurnNaming = AgentJournalConnectorDelivery['conversation']

/** A turn's row, opener and steered sends, each found by index: work is the turn's own rows (every
 *  send steered into it, all needed to prove none was a delivery), never the chat's send history (an
 *  operation window scans every current send). `through`: the sequence its end was read at; a row
 *  written later is not the ended turn's. `naming`: only whether it answered that conversation, one stamp
 *  naming it at most, found by reading the fewest sends; opener and messages stay null. */
export function readJournalDomainTurnAttribution(
  scope: JournalSqlScope,
  turnId: string,
  through: number,
  naming?: JournalTurnNaming
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
  if (naming) {
    const stamps = stampNaming(scope, row.itemId, opener, naming, ended)
    return { cursor, turnItemId: row.itemId, opener: null, stamps, messages: null }
  }
  const submissions = [...steeredSends(scope, row.itemId)]
  const items = submissions.flatMap((submission) => {
    const key = agentJournalSubmissionKey(submission.clientMessageId)
    const item = ended(journalVisibleItem(scope.db, scope.prefix, key))
    return item ? [item] : []
  })
  return {
    cursor,
    turnItemId: row.itemId,
    opener,
    stamps: connectorReplyTurnStamps({ items, submissions }, opener, row.itemId),
    messages: journalTurnAnsweredMessages({ items, submissions }, opener, row.itemId)
  }
}

/** Every current send steered into the turn row, in order, decoded as it is reached. */
function* steeredSends(
  scope: JournalSqlScope,
  turnItemId: string
): Iterable<AgentJournalSubmission> {
  const sends = scope.db
    .prepare(`SELECT payload_json FROM journal_submission_attempts INDEXED BY journal_submission_steer
    WHERE session_id=? AND epoch=? AND current=1 AND steer_turn_item_id=?
    ORDER BY accepted_sequence,ordinal`)
    .iterate(...scope.prefix, turnItemId)
  for (const send of sends) {
    yield scope.decode<AgentJournalSubmission>(scope.examined(send).payload_json)
  }
}

/** At most one stamp naming the conversation: the opener's (or its claim's) first, then each
 *  steered send's in order, its message read only while none before named it. */
function stampNaming(
  scope: JournalSqlScope,
  turnItemId: string,
  opener: AgentJournalRenderItem | null,
  naming: JournalTurnNaming,
  ended: (item: AgentJournalRenderItem | null) => AgentJournalRenderItem | null
): AgentJournalConnectorDelivery[] {
  const named = (stamps: AgentJournalConnectorDelivery[]) =>
    stamps.find(
      ({ conversation }) =>
        conversation.source === naming.source && conversation.externalId === naming.externalId
    )
  const fromOpener = named(
    connectorReplyTurnStamps({ items: [], submissions: [] }, opener, turnItemId)
  )
  if (fromOpener) {
    return [fromOpener]
  }
  for (const submission of steeredSends(scope, turnItemId)) {
    const answered = submission.answeredInTurn
    if (answered?.via !== 'steer' || answered.turnItemId !== turnItemId) {
      continue
    }
    const key = agentJournalSubmissionKey(submission.clientMessageId)
    const item = ended(journalVisibleItem(scope.db, scope.prefix, key))
    const stamp =
      item &&
      named(
        connectorReplyTurnStamps({ items: [item], submissions: [submission] }, null, turnItemId)
      )
    if (stamp) {
      return [stamp]
    }
  }
  return []
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
