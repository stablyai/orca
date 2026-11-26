// The one place a paired server's Dispatch is recorded here, with who started it.
import type { OrchestrationDb } from '../orchestration-db'
import type { RemoteRunLinkRow } from './remote-run-links'
import { getRemoteDispatch, type RemoteDispatchRow } from './remote-dispatch-records'
import { writtenRow } from './written-row'

/** What names a server's Dispatch here. `earlierDispatchId`: the server's Dispatch it continues (a
 *  follow-up) or whose worker started it (a helper). */
export type RemoteDispatchIdentity = {
  dispatchId: string
  taskId: string
  agent?: string | null
  worktreeId?: string | null
  earlierDispatchId?: string | null
}

/** Identity only: which server runs the Dispatch, for which Task, in which workspace, and who started
 *  it. State comes from the server's queue. Every path that learns of a server's Dispatch records it
 *  here, so its creator is stamped in this one place: its placement's (whoever started the Task
 *  there), else the earlier Dispatch's it continues or was started by. The first creator stands; a
 *  later answer only fills what is missing, so the queue and a start's answer agree in any order. */
export function ensureRemoteDispatchRecord(
  db: OrchestrationDb,
  link: RemoteRunLinkRow,
  identity: RemoteDispatchIdentity
): RemoteDispatchRow {
  db.db
    .prepare(
      `WITH creator AS (
         SELECT creator_orca_session_id AS session, creator_pane_key AS pane, 1 AS rank
         FROM remote_placements WHERE task_id = ?5 AND conversation_id = ?2
         UNION ALL
         SELECT creator_orca_session_id, creator_pane_key, 2
         FROM remote_dispatches WHERE dispatch_id = ?8
       ),
       chosen AS (
         SELECT session, pane FROM creator WHERE session IS NOT NULL OR pane IS NOT NULL
         ORDER BY rank LIMIT 1
       )
       INSERT INTO remote_dispatches (
         dispatch_id, conversation_id, run_id, environment_id, task_id, agent,
         creator_orca_session_id, creator_pane_key, worktree_id
       )
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, (SELECT session FROM chosen), (SELECT pane FROM chosen), ?7
       WHERE true
       ON CONFLICT(dispatch_id) DO UPDATE SET
         agent = COALESCE(remote_dispatches.agent, excluded.agent),
         worktree_id = COALESCE(remote_dispatches.worktree_id, excluded.worktree_id),
         creator_orca_session_id = CASE
           WHEN remote_dispatches.creator_orca_session_id IS NULL
             AND remote_dispatches.creator_pane_key IS NULL
           THEN excluded.creator_orca_session_id ELSE remote_dispatches.creator_orca_session_id END,
         creator_pane_key = CASE
           WHEN remote_dispatches.creator_orca_session_id IS NULL
             AND remote_dispatches.creator_pane_key IS NULL
           THEN excluded.creator_pane_key ELSE remote_dispatches.creator_pane_key END`
    )
    .run(
      identity.dispatchId,
      link.conversation_id,
      link.run_id,
      link.environment_id,
      identity.taskId,
      identity.agent ?? null,
      identity.worktreeId ?? null,
      identity.earlierDispatchId ?? null
    )
  return writtenRow(getRemoteDispatch(db, identity.dispatchId), `Dispatch ${identity.dispatchId}`)
}
