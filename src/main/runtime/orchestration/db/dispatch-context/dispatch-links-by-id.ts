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
}

export const DISPATCH_LINK_COLUMNS = `d.id, d.status, d.last_failure, d.creator_orca_session_id, d.creator_pane_key,
  d.assignee_orca_session_id, d.assignee_pane_key, COALESCE(w.worktree_id, r.worktree_id) AS worktree_id,
  COALESCE(d.completed_at, d.created_at) AS at, d.completed_at,
  COALESCE(t.task_title, t.display_name) AS title`
export const DISPATCH_LINK_JOINS = `LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
  LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = d.id
  LEFT JOIN tasks t ON t.id = d.task_id`

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
            title: textOrNull('title' in row ? row.title : null)
          }
        ]
      : []
  )
}

const DISPATCH_LINKS_BY_IDS_SQL = `
  SELECT ${DISPATCH_LINK_COLUMNS} FROM dispatch_contexts d ${DISPATCH_LINK_JOINS}
  WHERE d.id IN (SELECT value FROM json_each(?1))`

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
