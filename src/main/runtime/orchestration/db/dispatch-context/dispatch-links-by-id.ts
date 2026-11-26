// The columns that place a Dispatch under the chat that created it. A bot's chats tree re-reads only the
// Dispatches a change touched, by id, instead of its whole history.
import type { DispatchContextRow } from '../orchestration-records'
import type { OrchestrationDb } from '../orchestration-db'
import { exposeUtcTimestamp } from '../utc-timestamp'
import type { CreatedDispatch } from './dispatch-context-store'

/** A Dispatch with who created it and who runs it, so a worker's own workers trace back to its creator. */
export type DispatchCreatorLink = CreatedDispatch & {
  status: DispatchContextRow['status']
  assigneeOrcaSessionId: string | null
  assigneePaneKey: string | null
  worktreeId: string | null
  /** Epoch ms it settled, else when it was created. */
  at: number
  /** Whether it has a completion time on record: a settled row without one (written by an early failure
   *  path; adopted legacy runs are kept) has only its creation in `at`. */
  completedAtKnown: boolean
  /** Why it failed; 'stopped' when the user stopped it. */
  lastFailure: string | null
  /** Its Task's title, else display name; null for neither. */
  title: string | null
  /** The paired server that runs it as its own (worker-start --on); null for this Orca's. */
  serverEnvironmentId: string | null
  /** The agent the server named for it; null for this Orca's, whose worker record names it. */
  serverAgent: string | null
}

export const DISPATCH_LINK_COLUMNS = `d.id, d.status, d.last_failure, d.creator_orca_session_id, d.creator_pane_key,
  d.assignee_orca_session_id, d.assignee_pane_key, COALESCE(w.worktree_id, r.worktree_id) AS worktree_id,
  COALESCE(d.completed_at, d.created_at) AS at, d.completed_at,
  COALESCE(t.task_title, t.display_name) AS title,
  NULL AS server_environment_id, NULL AS server_agent`
export const DISPATCH_LINK_JOINS = `LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
  LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = d.id
  LEFT JOIN tasks t ON t.id = d.task_id`

/** A Dispatch a paired server runs as its own, in DISPATCH_LINK_COLUMNS' shape. Abandoned here, it is
 *  settled here; its workers' own Dispatches are the server's, so it names no assignee. */
const REMOTE_SETTLED = `(rd.task_settled_here = 2 OR rd.status NOT IN ('pending', 'dispatched'))`
export const REMOTE_DISPATCH_LINK_COLUMNS = `rd.dispatch_id AS id,
  CASE WHEN rd.task_settled_here = 2 AND rd.status IN ('pending', 'dispatched') THEN 'failed'
    ELSE rd.status END AS status,
  CASE WHEN rd.task_settled_here = 2 THEN 'abandoned'
    WHEN rd.worker_state IN ('stopped', 'abandoned') THEN rd.worker_state
    ELSE rd.last_failure END AS last_failure,
  rd.creator_orca_session_id, rd.creator_pane_key,
  NULL AS assignee_orca_session_id, NULL AS assignee_pane_key, rd.worktree_id,
  CASE WHEN ${REMOTE_SETTLED} THEN rd.updated_at ELSE rd.created_at END AS at,
  CASE WHEN ${REMOTE_SETTLED} THEN rd.updated_at END AS completed_at,
  COALESCE(t.task_title, t.display_name) AS title,
  rd.environment_id AS server_environment_id, rd.agent AS server_agent`
export const REMOTE_DISPATCH_LINK_JOINS = `LEFT JOIN tasks t ON t.id = rd.task_id`

function sqliteUtcMs(value: unknown): number {
  // Either datetime('now') (UTC, no zone) or an ISO string with its own zone.
  const ms = typeof value === 'string' ? Date.parse(exposeUtcTimestamp(value) ?? value) : Number.NaN
  return Number.isFinite(ms) ? ms : 0
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

export function dispatchLinkRows(rows: unknown[]): DispatchCreatorLink[] {
  return rows.flatMap((row) =>
    typeof row === 'object' && row !== null && 'id' in row && typeof row.id === 'string'
      ? [
          {
            id: row.id,
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the column's CHECK constraint limits it to DispatchContextRow's statuses.
            status: ('status' in row ? row.status : 'pending') as DispatchContextRow['status'],
            creatorOrcaSessionId: textOrNull(
              'creator_orca_session_id' in row ? row.creator_orca_session_id : null
            ),
            creatorPaneKey: textOrNull('creator_pane_key' in row ? row.creator_pane_key : null),
            assigneeOrcaSessionId: textOrNull(
              'assignee_orca_session_id' in row ? row.assignee_orca_session_id : null
            ),
            assigneePaneKey: textOrNull('assignee_pane_key' in row ? row.assignee_pane_key : null),
            worktreeId: textOrNull('worktree_id' in row ? row.worktree_id : null),
            at: sqliteUtcMs('at' in row ? row.at : null),
            completedAtKnown: sqliteUtcMs('completed_at' in row ? row.completed_at : null) > 0,
            lastFailure: textOrNull('last_failure' in row ? row.last_failure : null),
            title: textOrNull('title' in row ? row.title : null),
            serverEnvironmentId: textOrNull(
              'server_environment_id' in row ? row.server_environment_id : null
            ),
            serverAgent: textOrNull('server_agent' in row ? row.server_agent : null)
          }
        ]
      : []
  )
}

const DISPATCH_LINKS_BY_IDS_SQL = `
  SELECT ${DISPATCH_LINK_COLUMNS} FROM dispatch_contexts d ${DISPATCH_LINK_JOINS}
  WHERE d.id IN (SELECT value FROM json_each(?1))
  UNION ALL
  SELECT ${REMOTE_DISPATCH_LINK_COLUMNS} FROM remote_dispatches rd ${REMOTE_DISPATCH_LINK_JOINS}
  WHERE rd.dispatch_id IN (SELECT value FROM json_each(?1))`

/** These Dispatches, as `listDispatchLinksCreatedByAny` reads them; an unknown id is left out. */
export function listDispatchLinksByIds(
  this: OrchestrationDb,
  dispatchIds: readonly string[]
): DispatchCreatorLink[] {
  return dispatchIds.length === 0
    ? []
    : dispatchLinkRows(this.db.prepare(DISPATCH_LINKS_BY_IDS_SQL).all(JSON.stringify(dispatchIds)))
}

export type DispatchLinksByIdMethods = { listDispatchLinksByIds: typeof listDispatchLinksByIds }

export function attachDispatchLinksById(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { listDispatchLinksByIds })
}
