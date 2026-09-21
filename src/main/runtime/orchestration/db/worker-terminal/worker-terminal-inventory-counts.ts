import { deriveWorkerTerminalListState } from '../../worker-terminal-ownership'
import type {
  WorkerDispatchListState,
  WorkerTerminalListState,
  WorkerTerminalOwnershipState,
  WorkerTerminalReleaseState
} from '../../worker-terminal-ownership'
import type { OrchestrationDb } from '../orchestration-db'
import type { WorkerTerminalListingSnapshot } from './worker-terminal-listing'

export type WorkerTerminalStateRow = {
  dispatchId: string
  databaseId: number
  terminalState: WorkerTerminalListState | null
}

type WorkerTerminalInventoryParams = {
  runId?: string
  snapshot?: WorkerTerminalListingSnapshot
  terminalState?: WorkerTerminalListState
}

function buildInventoryScope(params: WorkerTerminalInventoryParams): {
  where: string[]
  values: (string | number)[]
} {
  const orderExpression = 'COALESCE(w.created_at, d.created_at)'
  const where: string[] = []
  const values: (string | number)[] = []
  if (params.runId) {
    where.push('d.run_id = ?')
    values.push(params.runId)
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
  return { where, values }
}

/** The only place worker terminal state is derived for filtering or counting: raw columns out of
 *  SQL, the verdict from the one TS state machine, so no second copy can drift from it. */
export function scanWorkerTerminalStates(
  this: OrchestrationDb,
  where: string[],
  values: (string | number)[]
): WorkerTerminalStateRow[] {
  const rows = this.db
    .prepare(
      `SELECT d.id AS dispatch_id,
              d.rowid AS database_id,
              COALESCE(w.state, 'unsupervised') AS worker_state,
              COALESCE(w.agent_terminal_handle, d.assignee_handle) AS agent_terminal_handle,
              r.id AS resource_id, r.ownership_state, r.release_state
         FROM dispatch_contexts d
         LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
         LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = d.id
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY d.rowid ASC`
    )
    .all(...values) as {
    dispatch_id: string
    database_id: number
    worker_state: WorkerDispatchListState
    agent_terminal_handle: string | null
    resource_id: string | null
    ownership_state: WorkerTerminalOwnershipState | null
    release_state: WorkerTerminalReleaseState | null
  }[]
  return rows.map((row) => ({
    dispatchId: row.dispatch_id,
    databaseId: row.database_id,
    terminalState: deriveWorkerTerminalListState({
      workerState: row.worker_state,
      agentTerminalHandle: row.agent_terminal_handle,
      resource:
        row.resource_id === null
          ? null
          : {
              ownership_state: row.ownership_state as WorkerTerminalOwnershipState,
              release_state: row.release_state as WorkerTerminalReleaseState
            }
    })
  }))
}

export function countWorkerTerminalInventory(
  this: OrchestrationDb,
  params: WorkerTerminalInventoryParams = {}
): {
  total: number
  counts: Partial<Record<WorkerTerminalListState, number>>
} {
  const { where, values } = buildInventoryScope(params)
  const rows = scanWorkerTerminalStates.call(this, where, values)
  const counts: Partial<Record<WorkerTerminalListState, number>> = {}
  for (const row of rows) {
    if (row.terminalState) {
      counts[row.terminalState] = (counts[row.terminalState] ?? 0) + 1
    }
  }
  return {
    total: params.terminalState ? (counts[params.terminalState] ?? 0) : rows.length,
    counts
  }
}
