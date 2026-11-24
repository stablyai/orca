// Whether a chat still waits on something that comes back to it: an answer to a question or handoff
// it sent another bot or chat, here or on a paired computer, a report from a worker it started, or
// mail already stored for it or its Run but not yet handed to it. A chat closed then never takes it.
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../shared/agent-session/identity/orca-session-address-prefix'
import type { OrchestrationDb } from '../orchestration-db'

/** Each part is an indexed lookup: idx_messages_bot_request_sender (then idx_thread for a reply),
 *  idx_peer_questions_out_asker_awaiting, idx_peer_handoffs_out_asker, idx_messages_native_direct_work,
 *  idx_dispatch_creator_orca_session_id, and idx_runs_coordinator_orca_session_id with
 *  idx_messages_native_account_work. Four lists of `count` addresses, then two of `count` ids. */
export function sessionAwaitsMailSql(count: number): string {
  const list = Array.from({ length: count }, () => '?').join(',')
  // A bot request is owed until its outcome; one to any other chat until its recipient replies in it.
  return `SELECT 1 FROM messages m
    WHERE m.from_handle IN (${list}) AND m.type IN ('question', 'handoff')
      AND CASE WHEN EXISTS (SELECT 1 FROM bot_requests b WHERE b.message_id = m.id)
        THEN NOT EXISTS (SELECT 1 FROM bot_request_outcomes o WHERE o.message_id = m.id)
        ELSE NOT EXISTS (
          SELECT 1 FROM messages r WHERE r.thread_id = COALESCE(m.thread_id, m.id)
            AND r.from_handle = m.to_handle AND r.created_at >= m.created_at)
      END
    UNION ALL
    SELECT 1 FROM peer_questions_out WHERE awaiting = 1 AND asker IN (${list})
    UNION ALL
    SELECT 1 FROM peer_handoffs_out WHERE asker IN (${list})
    UNION ALL
    SELECT 1 FROM messages
    WHERE to_handle IN (${list}) AND read = 0 AND delivered_at IS NULL
      AND delivery_contract <> 'audit_only'
    UNION ALL
    SELECT 1 FROM dispatch_contexts
    WHERE creator_orca_session_id IN (${list}) AND status IN ('pending', 'dispatched')
    UNION ALL
    SELECT 1 FROM runs run JOIN messages mail
      ON mail.run_id = run.id AND mail.to_handle = 'run:' || run.id
    WHERE run.coordinator_orca_session_id IN (${list}) AND mail.read = 0
      AND mail.delivered_at IS NULL AND mail.delivery_contract <> 'audit_only'
    LIMIT 1`
}

export function sessionAwaitsMail(db: OrchestrationDb, sessionIds: readonly string[]): boolean {
  const ids = [...new Set(sessionIds)]
  const addresses = ids.map((id) => `${ORCA_SESSION_ADDRESS_PREFIX}${id}`)
  return (
    db.db
      .prepare(sessionAwaitsMailSql(ids.length))
      .get(...addresses, ...addresses, ...addresses, ...addresses, ...ids, ...ids) !== undefined
  )
}
