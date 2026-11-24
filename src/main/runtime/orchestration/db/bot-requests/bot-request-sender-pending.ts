// Whether a chat still waits on an answer to a question or handoff it sent another bot, here or on a
// paired computer: a chat closed then could never take the reply.
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../shared/agent-session/identity/orca-session-address-prefix'
import type { OrchestrationDb } from '../orchestration-db'

/** Served by idx_messages_bot_request_sender and idx_peer_questions_out_asker_awaiting. */
export function sessionAwaitsBotReply(db: OrchestrationDb, sessionIds: readonly string[]): boolean {
  const senders = [...new Set(sessionIds)].map((id) => `${ORCA_SESSION_ADDRESS_PREFIX}${id}`)
  const placeholders = senders.map(() => '?').join(',')
  return (
    db.db
      .prepare(
        `SELECT 1 FROM messages m
         WHERE m.from_handle IN (${placeholders}) AND m.type IN ('question', 'handoff')
           AND EXISTS (SELECT 1 FROM bot_requests b WHERE b.message_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM bot_request_outcomes o WHERE o.message_id = m.id)
         UNION ALL
         SELECT 1 FROM peer_questions_out WHERE awaiting = 1 AND asker IN (${placeholders})
         LIMIT 1`
      )
      .get(...senders, ...senders) !== undefined
  )
}
