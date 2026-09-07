import type { DispatchStatus } from '../../types'
import type { TerminalExitCause } from '../../../../../shared/terminal-exit-cause'
import { deriveWorkerTerminalListState } from '../../worker-terminal-ownership'
import type {
  WorkerDispatchListState,
  WorkerTerminalResourceRow,
  WorkerTerminalListState
} from '../../worker-terminal-ownership'
import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import {
  getWorkerAttentionFacts,
  getWorkerAttentionFactsForDispatches
} from './worker-terminal-attention-query'
import {
  countWorkerTerminalInventory,
  scanWorkerTerminalStates
} from './worker-terminal-inventory-counts'
import { markWorkerTerminalUserOwned } from './worker-terminal-user-takeover'

export {
  countWorkerTerminalInventory,
  getWorkerAttentionFacts,
  getWorkerAttentionFactsForDispatches,
  markWorkerTerminalUserOwned
}

/** `databaseId` is the real order key; the timestamp fields only satisfy pre-v3 cursors. */
export type WorkerTerminalOrderingKey = {
  createdAt: string
  dispatchId: string
  databaseId?: number
}
export type WorkerTerminalListingSnapshot =
  | { databaseId: number }
  | { createdAt: string; dispatchId: string }

export function listWorkerTerminalReleaseBacklog(
  this: OrchestrationDb
): WorkerTerminalResourceRow[] {
  return this.db
    .prepare(
      `SELECT * FROM worker_terminal_resources
        WHERE release_state IN ('requested', 'releasing')
        ORDER BY release_requested_at ASC`
    )
    .all() as WorkerTerminalResourceRow[]
}

export const WORKER_LIST_CURSOR_EXPIRED_MESSAGE =
  'The worker inventory changed destructively while paging. Restart without --cursor.'

/** The anchor must still belong to the filtered set. An anchor from another Run resolved to a
 *  rowid past this Run's rows, so the page read as a finished, empty inventory. */
function resolveAnchorRowId(
  this: OrchestrationDb,
  after: WorkerTerminalOrderingKey,
  runId: string | undefined
): number {
  const conditions = ['id = ?']
  const values: (string | number)[] = [after.dispatchId]
  if (runId) {
    conditions.push('run_id = ?')
    values.push(runId)
  }
  if (after.databaseId !== undefined) {
    conditions.push('rowid = ?')
    values.push(after.databaseId)
  }
  const anchor = this.db
    .prepare(`SELECT rowid AS rowid FROM dispatch_contexts WHERE ${conditions.join(' AND ')}`)
    .get(...values) as { rowid: number } | undefined
  if (!anchor) {
    throw new OrchestrationError('worker_list_cursor_expired', WORKER_LIST_CURSOR_EXPIRED_MESSAGE)
  }
  return anchor.rowid
}

export function listWorkerTerminalResources(
  this: OrchestrationDb,
  params: {
    runId?: string
    limit?: number
    after?: WorkerTerminalOrderingKey
    snapshot?: WorkerTerminalListingSnapshot
    terminalState?: WorkerTerminalListState
    dispatchIds?: string[]
  } = {}
): {
  dispatchId: string
  taskId: string
  runId: string
  parentTaskId: string | null
  workerState: WorkerDispatchListState
  dispatchStatus: DispatchStatus
  workerStage: string | null
  agentTerminalHandle: string | null
  paneKey: string | null
  worktreeId: string | null
  terminalState: WorkerTerminalListState | null
  pendingInput: boolean
  pendingApproval: boolean
  terminationReason: TerminalExitCause['kind'] | null
  resource: WorkerTerminalResourceRow | null
  createdAt: string
  databaseId: number
}[] {
  const orderExpression = 'COALESCE(w.created_at, d.created_at)'
  const where: string[] = []
  const values: (string | number)[] = []
  if (params.runId) {
    where.push('d.run_id = ?')
    values.push(params.runId)
  }
  if (params.dispatchIds) {
    if (params.dispatchIds.length === 0) {
      return []
    }
    where.push(`d.id IN (${params.dispatchIds.map(() => '?').join(',')})`)
    values.push(...params.dispatchIds)
  }
  if (params.snapshot) {
    if ('databaseId' in params.snapshot) {
      where.push('d.rowid <= ?')
      values.push(params.snapshot.databaseId)
    } else {
      where.push(`(${orderExpression} < ? OR (${orderExpression} = ? AND d.id <= ?))`)
      values.push(params.snapshot.createdAt, params.snapshot.createdAt, params.snapshot.dispatchId)
    }
  }
  if (params.after) {
    // Order and fence must share one key, or a row created between pages moves across the cut.
    // A pre-v3 cursor is resolved from its anchor row; when a reset deleted that row
    // `rowid > NULL` matched nothing and the page read as a finished, empty inventory.
    where.push('d.rowid > ?')
    values.push(resolveAnchorRowId.call(this, params.after, params.runId))
  }
  let detailWhere = where
  let detailValues = values
  let detailLimit = params.limit
  if (params.terminalState) {
    // Terminal state is derived by one TS function; page it before reading detail columns.
    const matching = scanWorkerTerminalStates
      .call(this, where, values)
      .filter((row) => row.terminalState === params.terminalState)
    const page = detailLimit === undefined ? matching : matching.slice(0, detailLimit)
    if (page.length === 0) {
      return []
    }
    detailWhere = [`d.rowid IN (${page.map(() => '?').join(',')})`]
    detailValues = page.map((row) => row.databaseId)
    detailLimit = undefined
  }
  const limitClause = detailLimit === undefined ? '' : ' LIMIT ?'
  if (detailLimit !== undefined) {
    detailValues.push(detailLimit)
  }
  const rows = this.db
    .prepare(
      `SELECT d.id AS dispatch_id,
              d.rowid AS database_id,
              ${orderExpression} AS created_at,
              COALESCE(w.state, 'unsupervised') AS worker_state,
              COALESCE(w.agent_terminal_handle, d.assignee_handle) AS agent_terminal_handle,
              COALESCE(r.pane_key, d.assignee_pane_key) AS pane_key,
              COALESCE(w.worktree_id, r.worktree_id) AS worktree_id,
              w.stage AS worker_stage,
              t.parent_id AS parent_task_id,
              d.task_id, d.run_id, d.status AS dispatch_status,
              d.termination_reason,
              EXISTS (
                SELECT 1 FROM question_threads q
                 WHERE q.dispatch_id = d.id AND q.status = 'pending'
              ) AS pending_input,
              EXISTS (
                SELECT 1 FROM decision_gates g
                 WHERE g.task_id = d.task_id AND g.status = 'pending'
              ) AS pending_approval
         FROM dispatch_contexts d
         LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
         LEFT JOIN tasks t ON t.id = d.task_id AND t.run_id = d.run_id
         LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = d.id
        ${detailWhere.length > 0 ? `WHERE ${detailWhere.join(' AND ')}` : ''}
        ORDER BY d.rowid ASC${limitClause}`
    )
    .all(...detailValues) as {
    dispatch_id: string
    worker_state: WorkerDispatchListState
    agent_terminal_handle: string | null
    pane_key: string | null
    worktree_id: string | null
    worker_stage: string | null
    parent_task_id: string | null
    task_id: string
    run_id: string
    dispatch_status: DispatchStatus
    termination_reason: TerminalExitCause['kind'] | null
    pending_input: number
    pending_approval: number
    created_at: string
    database_id: number
  }[]
  const resources =
    rows.length === 0
      ? []
      : (this.db
          .prepare(
            `SELECT r.* FROM worker_terminal_resources r
               WHERE r.owner_dispatch_id IN (${rows.map(() => '?').join(',')})`
          )
          .all(...rows.map((row) => row.dispatch_id)) as WorkerTerminalResourceRow[])
  const resourceByOwner = new Map(
    resources.map((resource) => [resource.owner_dispatch_id, resource])
  )
  return rows.map((row) => {
    const resource = resourceByOwner.get(row.dispatch_id) ?? null
    return {
      dispatchId: row.dispatch_id,
      taskId: row.task_id,
      runId: row.run_id,
      parentTaskId: row.parent_task_id,
      workerState: row.worker_state,
      dispatchStatus: row.dispatch_status,
      workerStage: row.worker_stage,
      agentTerminalHandle: row.agent_terminal_handle,
      paneKey: row.pane_key,
      worktreeId: row.worktree_id,
      terminalState: deriveWorkerTerminalListState({
        workerState: row.worker_state,
        agentTerminalHandle: row.agent_terminal_handle,
        resource
      }),
      pendingInput: row.pending_input === 1,
      pendingApproval: row.pending_approval === 1,
      terminationReason: row.termination_reason,
      resource,
      createdAt: row.created_at,
      databaseId: row.database_id
    }
  })
}
export function getWorkerTerminalListingSnapshot(
  this: OrchestrationDb,
  runId?: string
): { databaseId: number } | null {
  const row = this.db
    .prepare(
      `SELECT MAX(d.rowid) AS database_id
         FROM dispatch_contexts d
        ${runId ? 'WHERE d.run_id = ?' : ''}`
    )
    .get(...(runId ? [runId] : [])) as { database_id: number | null }
  return row.database_id === null ? null : { databaseId: row.database_id }
}
export function getWorkerTerminalOrderingKey(
  this: OrchestrationDb,
  dispatchId: string
): WorkerTerminalOrderingKey | null {
  const row = this.db
    .prepare(
      `SELECT d.id AS dispatch_id, d.rowid AS database_id,
              COALESCE(w.created_at, d.created_at) AS created_at
         FROM dispatch_contexts d
         LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
        WHERE d.id = ?`
    )
    .get(dispatchId) as { dispatch_id: string; created_at: string; database_id: number } | undefined
  return row
    ? { createdAt: row.created_at, dispatchId: row.dispatch_id, databaseId: row.database_id }
    : null
}

export type WorkerTerminalListingMethods = {
  markWorkerTerminalUserOwned: typeof markWorkerTerminalUserOwned
  listWorkerTerminalReleaseBacklog: typeof listWorkerTerminalReleaseBacklog
  listWorkerTerminalResources: typeof listWorkerTerminalResources
  getWorkerTerminalListingSnapshot: typeof getWorkerTerminalListingSnapshot
  getWorkerTerminalOrderingKey: typeof getWorkerTerminalOrderingKey
  countWorkerTerminalInventory: typeof countWorkerTerminalInventory
  getWorkerAttentionFacts: typeof getWorkerAttentionFacts
  getWorkerAttentionFactsForDispatches: typeof getWorkerAttentionFactsForDispatches
}

export function attachWorkerTerminalListing(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    markWorkerTerminalUserOwned,
    listWorkerTerminalReleaseBacklog,
    listWorkerTerminalResources,
    getWorkerTerminalListingSnapshot,
    getWorkerTerminalOrderingKey,
    countWorkerTerminalInventory,
    getWorkerAttentionFacts,
    getWorkerAttentionFactsForDispatches
  })
}
