// Whether a chat still waits on mail: an answer to a question or handoff it sent another bot, here or
// on a paired computer, or mail already stored for it but not yet handed to it. A chat closed then
// could never take it.
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../shared/agent-session/identity/orca-session-address-prefix'
import type { OrchestrationDb } from '../orchestration-db'

/** Served by idx_messages_bot_request_sender, idx_peer_questions_out_asker_awaiting and
 *  idx_messages_native_direct_work; one placeholder list per part, `count` addresses each. */
export function sessionAwaitsMailSql(count: number): string {
  const list = Array.from({ length: count }, () => '?').join(',')
  return `SELECT 1 FROM messages m
    WHERE m.from_handle IN (${list}) AND m.type IN ('question', 'handoff')
      AND EXISTS (SELECT 1 FROM bot_requests b WHERE b.message_id = m.id)
      AND NOT EXISTS (SELECT 1 FROM bot_request_outcomes o WHERE o.message_id = m.id)
    UNION ALL
    SELECT 1 FROM peer_questions_out WHERE awaiting = 1 AND asker IN (${list})
    UNION ALL
    SELECT 1 FROM messages
    WHERE to_handle IN (${list}) AND read = 0 AND delivered_at IS NULL
      AND delivery_contract <> 'audit_only'
    LIMIT 1`
}

export function sessionAwaitsMail(db: OrchestrationDb, sessionIds: readonly string[]): boolean {
  const addresses = [...new Set(sessionIds)].map((id) => `${ORCA_SESSION_ADDRESS_PREFIX}${id}`)
  return (
    db.db
      .prepare(sessionAwaitsMailSql(addresses.length))
      .get(...addresses, ...addresses, ...addresses) !== undefined
  )
}
