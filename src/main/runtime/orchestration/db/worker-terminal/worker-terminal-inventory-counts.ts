import { deriveWorkerTerminalListState } from '../../worker-terminal-ownership'
import type {
  WorkerDispatchListState,
  WorkerTerminalListState,
  WorkerTerminalOwnershipState,
  WorkerTerminalReleaseState
} from '../../worker-terminal-ownership'
import type { OrchestrationDb } from '../orchestration-db'
import { WORKER_TERMINAL_PRIOR_OWNERS_SQL } from './worker-terminal-handed-on'
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

/** Derive all filtering/counting through the single state machine; newest-first order supports paging. */
export function scanWorkerTerminalStates(
  this: OrchestrationDb,
  where: string[],
  values: (string | number)[]
): WorkerTerminalStateRow[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this cast is unchanged and matches every other row cast in db/; the gate flags it only because this diff edits the ORDER BY inside its span.
  const rows = this.db
    .prepare(
      `SELECT d.id AS dispatch_id,
              d.rowid AS database_id,
              COALESCE(w.state, 'unsupervised') AS worker_state,
              COALESCE(w.agent_terminal_handle, d.assignee_handle) AS agent_terminal_handle,
              r.id AS resource_id, r.ownership_state, r.release_state,
              handed.release_state AS handed_on_release_state
         FROM dispatch_contexts d
         LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
         LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = d.id
         -- The latest hand-off wins: SQLite takes the bare column from the MAX row.
         LEFT JOIN (
           SELECT prior.value AS dispatch_id, p.release_state, MAX(p.updated_at)
             FROM ${WORKER_TERMINAL_PRIOR_OWNERS_SQL}
            WHERE p.prior_owner_dispatch_ids != '[]'
            GROUP BY prior.value
         ) handed ON r.id IS NULL AND handed.dispatch_id = d.id
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY d.rowid DESC`
    )
    .all(...values) as {
    dispatch_id: string
    database_id: number
    worker_state: WorkerDispatchListState
    agent_terminal_handle: string | null
    resource_id: string | null
    ownership_state: WorkerTerminalOwnershipState | null
    release_state: WorkerTerminalReleaseState | null
    handed_on_release_state: WorkerTerminalReleaseState | null
  }[]
  return rows.map((row) => ({
    dispatchId: row.dispatch_id,
    databaseId: row.database_id,
    terminalState: deriveWorkerTerminalListState({
      workerState: row.worker_state,
      agentTerminalHandle: row.agent_terminal_handle,
      resource:
        row.resource_id === null
          ? row.handed_on_release_state && {
              ownership_state: 'transferred',
              release_state: row.handed_on_release_state
            }
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
