// A bot's status to a bot that is waiting on it answers that wait: it goes as the reply to the
// recipient's open question or handoff, exactly as `orchestration reply --id <msg>` sends it, and wakes it.
import { canonicalOrcaSessionId } from '../../../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import { isOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { RpcContext } from '../../../core'
import { ORCHESTRATION_REPLY_METHOD } from './reply-method'

type WaitingRequest = { id: string; purpose: 'question' | 'handoff' }

/** The newest question or handoff `fromBotId` sent to this chat that has no outcome yet; the one
 *  `threadId` names when it is such a request. */
export function waitingRequest(
  db: OrchestrationDb,
  fromBotId: string,
  toBotId: string,
  sessionId: string,
  threadId: string | undefined
): WaitingRequest | null {
  const root = isOrcaSessionId(sessionId) ? canonicalOrcaSessionId(sessionId) : sessionId
  const chats = [...new Set([sessionId, root])].map((id) => `orca_session_id:${id}`)
  const row = db.db
    .prepare(
      `SELECT br.message_id AS id, br.purpose AS purpose
         FROM bot_requests br JOIN messages m ON m.id = br.message_id
        WHERE br.from_bot_id = ? AND br.to_bot_id = ? AND br.purpose IN ('question', 'handoff')
          AND m.to_handle IN (SELECT value FROM json_each(?)) AND m.from_handle <> m.to_handle
          AND NOT EXISTS (SELECT 1 FROM bot_request_outcomes o WHERE o.message_id = br.message_id)
        ORDER BY (br.message_id = ?) DESC, m.sequence DESC
        LIMIT 1`
    )
    .get(fromBotId, toBotId, JSON.stringify(chats), threadId ?? '')
  return row &&
    typeof row.id === 'string' &&
    (row.purpose === 'question' || row.purpose === 'handoff')
    ? { id: row.id, purpose: row.purpose }
    : null
}

/** Sends the status as the reply to `waiting`, through the reply method itself. */
export async function replyToWaiting(
  context: RpcContext,
  waiting: WaitingRequest,
  targetName: string,
  body: string
): Promise<unknown> {
  const receipt = await ORCHESTRATION_REPLY_METHOD.handler({ id: waiting.id, body }, context)
  const next = `Sent as your reply to ${targetName}'s ${waiting.purpose} ${waiting.id}, which it is waiting on, so it woke ${targetName}: the same as \`orca orchestration reply --id ${waiting.id}\`. Answer a waiting bot that way; don't send this again.`
  return receipt && typeof receipt === 'object' ? { ...receipt, next } : receipt
}
