import {
  JOURNAL_CONNECTOR_REPLY_PROSE_BYTES,
  type JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import { connectorReplyTurnOutcome } from '../../shared/agent-session/journal/journal-connector-reply-turn'
import { readAgentJournalTurn } from '../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { capAnswer } from '../connector-cloud/connector-snapshot'
import type {
  ReplyRecoveryVerdict,
  readReplyEvidence
} from './external-conversation-reply-evidence'

// The words an empty turn's held rows get when its retry never ran, with when that turn ended.

type Unfilled = JournalConnectorReplyRow

/** A row held for an empty turn's retry that never ran (refused, or the app quit first), whose
 *  turn finished: answered only by any words that turn wrote before its last tool. */
export function heldAnswer(
  row: Unfilled,
  view: Awaited<ReturnType<typeof readReplyEvidence>>
): ReplyRecoveryVerdict | null {
  if (!row.emptyRetried || !row.cut || view.cutTurnVerdict(row.cut.turnId) !== 'success') {
    return null
  }
  const { outcome, prose } = connectorReplyTurnOutcome({
    outcome: 'success',
    prose: view.cutTurnWords(row.cut.turnId),
    bot: true
  })
  const cutTurnId = row.cut.turnId
  const turn = view.snapshot.items.findLast((item) => item.itemId === cutTurnId)
  const endedAt = turn && (readAgentJournalTurn(turn.body)?.completedAt ?? turn.observedAt)
  return {
    outcome,
    ...(prose ? { prose: capAnswer(prose, JOURNAL_CONNECTOR_REPLY_PROSE_BYTES) } : {}),
    ...(endedAt === undefined ? {} : { endedAt })
  }
}
