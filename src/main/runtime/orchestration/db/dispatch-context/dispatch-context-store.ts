import type { DispatchContextRow } from '../orchestration-records'
import { guardChatCustody } from '../chat-custody-guard'
import { OrchestrationError } from '../../orchestration-error'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { ORCHESTRATION_CONTRACT_VERSION as CURRENT_CONTRACT_VERSION } from '../../../../../shared/orchestration/orchestration-runtime-capabilities'
import { generateId } from '../generated-id'
import { paneKeyMatchSuffix } from '../pane-key-match'
import { claimDispatchContextRow } from '../dispatch-row-writer'
import { recordedCreatorIdentity, type DispatchCreator } from '../dispatch-depth'
import type { OrchestrationDb } from '../orchestration-db'
import { transitionLifecycleWithDb } from '../lifecycle-transition'
import {
  taskNotFoundError,
  taskNotStartableError
} from '../../coordinator/dispatch/task-dispatch-refusal'
import { dispatchAssigneeOrcaSessionId } from '../../addressing/session-lineage/dispatch-assignee-orca-session-id'
import { assertTakesNewWork } from '../worker-terminal/worker-terminal-transfer'
import { exposeUtcTimestamp } from '../utc-timestamp'
import { retireRemotePlacement } from '../remote-owned/remote-placement-hold'
import { DISPATCH_CONTEXT_COLUMN_LIST } from '../row-column-lists'

export function createDispatchContext(
  this: OrchestrationDb,
  params: {
    taskId: string
    assigneeHandle: string
    // Pane identity survives handle reissue, preserving worker_done authority.
    assigneePaneKey?: string
    launchTokenHash?: string
    processIncarnation?: string
    /** The assignee's serialized host scope, matching its worker-terminal custody row. */
    hostScope?: string | null
    /** Who is dispatching, for nesting depth. Required so a new caller must decide. */
    creator: DispatchCreator
    maxDepth: number
  }
): DispatchContextRow {
  const { taskId, assigneeHandle, assigneePaneKey, launchTokenHash, processIncarnation } = params
  const depth = this.resolveChildDispatchDepth(params.creator, params.maxDepth)
  const task = this.getTask(taskId)
  if (!task) {
    throw taskNotFoundError(`Task not found: ${taskId}`, { taskId })
  }
  if (task.status !== 'ready') {
    throw taskNotStartableError(
      this,
      `Task ${taskId} is ${task.status}; only ready tasks can be dispatched`,
      task
    )
  }

  assertTakesNewWork(this, params, taskId)

  // Accumulate failure_count across task retries.
  const prior = this.db
    .prepare('SELECT MAX(failure_count) as max_failures FROM dispatch_contexts WHERE task_id = ?')
    .get(taskId) as { max_failures: number | null } | undefined
  const priorFailures = prior?.max_failures ?? 0

  const paneSuffix =
    assigneePaneKey && parsePaneKey(assigneePaneKey) ? paneKeyMatchSuffix(assigneePaneKey) : null
  const id = generateId('ctx')
  const creatorDispatchId = this.resolveCreatorDispatchId(params.creator)
  this.db.exec('SAVEPOINT create_dispatch_context')
  try {
    guardChatCustody(this, assigneeHandle, 'custody')
    const inserted = claimDispatchContextRow(this.db, {
      id,
      contractVersion: CURRENT_CONTRACT_VERSION,
      launchTokenHash: launchTokenHash ?? null,
      assigneeHandle,
      assigneePaneKey: assigneePaneKey ?? null,
      assigneeOrcaSessionId: dispatchAssigneeOrcaSessionId({
        handle: assigneeHandle,
        processIncarnation
      }),
      processIncarnation: processIncarnation ?? null,
      creatorDispatchId,
      ...recordedCreatorIdentity(params.creator),
      priorFailures,
      depth,
      taskId,
      paneSuffix
    })
    if (inserted.changes !== 1) {
      const current = this.getTask(taskId)
      const occupied = this.findActiveDispatchForAssignee(assigneeHandle, assigneePaneKey)
      if (current?.status === 'ready' && occupied) {
        throw new Error(
          `Terminal ${assigneeHandle} already has an active dispatch (${occupied.id} for task ${occupied.task_id})`
        )
      }
      // Return the same typed rejection for a lost atomic claim as for a failed precheck.
      const message = `Task ${taskId} is ${current?.status ?? 'missing'}; only ready tasks can be dispatched`
      throw current
        ? taskNotStartableError(this, message, current)
        : taskNotFoundError(message, { taskId })
    }
    transitionLifecycleWithDb(this.db, {
      entity: 'task',
      id: taskId,
      from: 'ready',
      to: 'dispatched'
    })
    // The Task runs here now; an earlier attempt on a paired server no longer speaks for it.
    retireRemotePlacement(this, taskId)
    const row = this.db
      .prepare(`SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts WHERE id = ?`)
      .get(id)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the column list names every column of the row type, and a missing one fails compilation; the row was just claimed in this savepoint.
    const dispatch = row as DispatchContextRow
    this.db.exec('RELEASE create_dispatch_context')
    this.hasAnyDispatchContextsCache = true
    return dispatch
  } catch (error) {
    this.db.exec('ROLLBACK TO create_dispatch_context')
    this.db.exec('RELEASE create_dispatch_context')
    throw error
  }
}

export function getDispatchContext(
  this: OrchestrationDb,
  taskId: string
): DispatchContextRow | undefined {
  return this.db
    .prepare('SELECT * FROM dispatch_contexts WHERE task_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(taskId) as DispatchContextRow | undefined
}

export function getDispatchContextById(
  this: OrchestrationDb,
  dispatchId: string
): DispatchContextRow | undefined {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the column list names every column of the row type, and a missing one fails compilation.
  return this.db
    .prepare(`SELECT ${DISPATCH_CONTEXT_COLUMN_LIST} FROM dispatch_contexts WHERE id = ?`)
    .get(dispatchId) as DispatchContextRow | undefined
}

/** The newest Dispatches a chat created, by the Orca session id it is addressed by. */
export function listDispatchIdsCreatedBySession(
  this: OrchestrationDb,
  orcaSessionId: string,
  limit: number
): string[] {
  const rows = this.db
    .prepare(
      'SELECT id FROM dispatch_contexts WHERE creator_orca_session_id = ? ORDER BY rowid DESC LIMIT ?'
    )
    .all(orcaSessionId, limit)
  return rows.flatMap((row) =>
    typeof row === 'object' && row !== null && 'id' in row && typeof row.id === 'string'
      ? [row.id]
      : []
  )
}

/** A Dispatch and the chat or pane that created it. */
export type CreatedDispatch = {
  id: string
  creatorOrcaSessionId: string | null
  creatorPaneKey: string | null
}

// Each creator column is matched through its own index; ids arrive as one JSON array, so no variable limit.
export const DISPATCHES_CREATED_BY_ANY_SQL = `
  WITH created AS (
    SELECT rowid AS seq, id, status, creator_orca_session_id, creator_pane_key FROM dispatch_contexts
    WHERE creator_orca_session_id IN (SELECT value FROM json_each(?1))
    UNION
    SELECT rowid AS seq, id, status, creator_orca_session_id, creator_pane_key FROM dispatch_contexts
    WHERE creator_pane_key IN (SELECT value FROM json_each(?2))
  )
  SELECT id, creator_orca_session_id, creator_pane_key FROM created
  WHERE status IN ('pending', 'dispatched')
  UNION
  SELECT id, creator_orca_session_id, creator_pane_key FROM (
    SELECT * FROM created ORDER BY seq DESC LIMIT ?3
  )`

/** In one query: every unsettled Dispatch these chats or panes created, and their newest `recentLimit` of any status. */
export function listDispatchesCreatedByAny(
  this: OrchestrationDb,
  creators: { orcaSessionIds: readonly string[]; paneKeys: readonly string[] },
  recentLimit: number
): CreatedDispatch[] {
  const rows = this.db
    .prepare(DISPATCHES_CREATED_BY_ANY_SQL)
    .all(JSON.stringify(creators.orcaSessionIds), JSON.stringify(creators.paneKeys), recentLimit)
  return rows.flatMap((row) =>
    typeof row === 'object' && row !== null && 'id' in row && typeof row.id === 'string'
      ? [
          {
            id: row.id,
            creatorOrcaSessionId:
              'creator_orca_session_id' in row && typeof row.creator_orca_session_id === 'string'
                ? row.creator_orca_session_id
                : null,
            creatorPaneKey:
              'creator_pane_key' in row && typeof row.creator_pane_key === 'string'
                ? row.creator_pane_key
                : null
          }
        ]
      : []
  )
}

/** A Dispatch with who created it and who runs it, so a worker's own workers trace back to its creator. */
export type DispatchCreatorLink = CreatedDispatch & {
  status: DispatchContextRow['status']
  assigneeOrcaSessionId: string | null
  assigneePaneKey: string | null
  worktreeId: string | null
  /** Epoch ms it settled, else when it was created. */
  at: number
  /** Why it failed; 'stopped' when the user stopped it. */
  lastFailure: string | null
  /** Its Task's title, else display name; null for neither. */
  title: string | null
}

export const DISPATCH_LINK_COLUMNS = `d.id, d.status, d.last_failure, d.creator_orca_session_id, d.creator_pane_key,
  d.assignee_orca_session_id, d.assignee_pane_key, COALESCE(w.worktree_id, r.worktree_id) AS worktree_id,
  COALESCE(d.completed_at, d.created_at) AS at, COALESCE(t.task_title, t.display_name) AS title`
export const DISPATCH_LINK_JOINS = `LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
  LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = d.id
  LEFT JOIN tasks t ON t.id = d.task_id`

export const DISPATCH_LINKS_CREATED_BY_ANY_SQL = `
  SELECT ${DISPATCH_LINK_COLUMNS} FROM dispatch_contexts d ${DISPATCH_LINK_JOINS}
  WHERE d.creator_orca_session_id IN (SELECT value FROM json_each(?1))
  UNION
  SELECT ${DISPATCH_LINK_COLUMNS} FROM dispatch_contexts d ${DISPATCH_LINK_JOINS}
  WHERE d.creator_pane_key IN (SELECT value FROM json_each(?2))`

function sqliteUtcMs(value: unknown): number {
  // Either datetime('now') (UTC, no zone) or an ISO string with its own zone.
  const ms = typeof value === 'string' ? Date.parse(exposeUtcTimestamp(value) ?? value) : Number.NaN
  return Number.isFinite(ms) ? ms : 0
}

const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** Every Dispatch these chats or panes created, of any age, with only the columns that place it. */
export function listDispatchLinksCreatedByAny(
  this: OrchestrationDb,
  creators: { orcaSessionIds: readonly string[]; paneKeys: readonly string[] }
): DispatchCreatorLink[] {
  return dispatchLinkRows(
    this.db
      .prepare(DISPATCH_LINKS_CREATED_BY_ANY_SQL)
      .all(JSON.stringify(creators.orcaSessionIds), JSON.stringify(creators.paneKeys))
  )
}

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
            lastFailure: textOrNull('last_failure' in row ? row.last_failure : null),
            title: textOrNull('title' in row ? row.title : null)
          }
        ]
      : []
  )
}

export function commitDispatchLaunchTokenHash(
  this: OrchestrationDb,
  dispatchId: string,
  launchTokenHash: string
): DispatchContextRow {
  const dispatch = this.getDispatchContextById(dispatchId)
  if (!dispatch) {
    throw new OrchestrationError('dispatch_not_found', `Dispatch ${dispatchId} was not found.`)
  }
  if (dispatch.contract_version !== CURRENT_CONTRACT_VERSION) {
    throw new OrchestrationError(
      'request_mismatch',
      `Dispatch ${dispatchId} does not use the current contract.`
    )
  }
  if (dispatch.launch_token_hash && dispatch.launch_token_hash !== launchTokenHash) {
    throw new OrchestrationError(
      'request_mismatch',
      `Dispatch ${dispatchId} already has a different launch-token commitment.`
    )
  }
  this.db
    .prepare(
      `UPDATE dispatch_contexts
       SET launch_token_hash = COALESCE(launch_token_hash, ?)
       WHERE id = ?`
    )
    .run(launchTokenHash, dispatchId)
  return this.getDispatchContextById(dispatchId) as DispatchContextRow
}

export type DispatchContextStoreMethods = {
  createDispatchContext: typeof createDispatchContext
  getDispatchContext: typeof getDispatchContext
  getDispatchContextById: typeof getDispatchContextById
  listDispatchIdsCreatedBySession: typeof listDispatchIdsCreatedBySession
  listDispatchesCreatedByAny: typeof listDispatchesCreatedByAny
  listDispatchLinksCreatedByAny: typeof listDispatchLinksCreatedByAny
  commitDispatchLaunchTokenHash: typeof commitDispatchLaunchTokenHash
}

export function attachDispatchContextStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createDispatchContext,
    getDispatchContext,
    getDispatchContextById,
    listDispatchIdsCreatedBySession,
    listDispatchesCreatedByAny,
    listDispatchLinksCreatedByAny,
    commitDispatchLaunchTokenHash
  })
}
