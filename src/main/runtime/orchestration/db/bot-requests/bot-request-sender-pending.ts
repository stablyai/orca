// Whether a chat still waits on something that comes back to it: an answer to a question or handoff
// it sent another bot or chat, here or on a paired computer, a report from a worker it started here or
// on a paired server, or mail stored for it or its Run but not yet handed to it. A chat closed then
// never takes it.
import { ORCA_SESSION_ADDRESS_PREFIX } from '../../../../../shared/agent-session/identity/orca-session-address-prefix'
import type { OrchestrationDb } from '../orchestration-db'
import { remoteDispatchOpenSql } from '../remote-owned/remote-dispatch-records'

/** Each part is an indexed lookup: idx_messages_bot_request_sender (then idx_messages_reply_to),
 *  idx_peer_questions_out_asker_awaiting, idx_peer_handoffs_out_asker, idx_messages_native_direct_work,
 *  idx_dispatch_creator_orca_session_id, and idx_runs_coordinator_orca_session_id with
 *  idx_messages_native_account_work or idx_remote_placements_run (under an open link only). Four lists of `count` addresses,
 *  then four of `count` ids. A worker on a paired server, or a helper it started there, is read
 *  from idx_remote_dispatches_creator. */
export function sessionAwaitsMailSql(count: number): string {
  const list = Array.from({ length: count }, () => '?').join(',')
  // A bot request is owed until its outcome; an ask of any other chat until a reply names it (a
  // notice that none will come names it too), wherever that reply was routed.
  return `SELECT 1 FROM messages m
    WHERE m.from_handle IN (${list}) AND m.type IN ('question', 'handoff')
      AND CASE WHEN EXISTS (SELECT 1 FROM bot_requests b WHERE b.message_id = m.id)
        THEN NOT EXISTS (SELECT 1 FROM bot_request_outcomes o WHERE o.message_id = m.id)
        ELSE NOT EXISTS (SELECT 1 FROM messages r WHERE r.reply_to = m.id)
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
    UNION ALL
    SELECT 1 FROM runs run JOIN remote_placements placement ON placement.run_id = run.id
      JOIN remote_run_links link
        ON link.conversation_id = placement.conversation_id AND link.state = 'open'
      JOIN tasks task ON task.id = placement.task_id
    WHERE run.coordinator_orca_session_id IN (${list})
      AND (placement.state = 'reserved' OR task.status = 'dispatched')
    UNION ALL
    SELECT 1 FROM remote_dispatches remote JOIN remote_run_links link
      ON link.conversation_id = remote.conversation_id AND link.state = 'open'
    WHERE remote.creator_orca_session_id IN (${list}) AND remote.task_settled_here = 0
      AND (${remoteDispatchOpenSql('remote')})
    LIMIT 1`
}

export function sessionAwaitsMail(db: OrchestrationDb, sessionIds: readonly string[]): boolean {
  const ids = [...new Set(sessionIds)]
  const addresses = ids.map((id) => `${ORCA_SESSION_ADDRESS_PREFIX}${id}`)
  return (
    db.db
      .prepare(sessionAwaitsMailSql(ids.length))
      .get(...[1, 2, 3, 4].flatMap(() => addresses), ...ids, ...ids, ...ids, ...ids) !== undefined
  )
}

/** The Runs these sessions coordinate, whose mailboxes hold their workers' reports. */
export function runsCoordinatedBy(db: OrchestrationDb, sessionIds: readonly string[]): string[] {
  const ids = [...new Set(sessionIds)]
  return db.db
    .prepare(
      `SELECT id FROM runs WHERE coordinator_orca_session_id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids)
    .map((row) => String(row.id))
}
