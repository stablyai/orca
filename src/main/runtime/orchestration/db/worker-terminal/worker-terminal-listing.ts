import type { DispatchStatus } from '../../types'
import { deriveWorkerTerminalListState } from '../../worker-terminal-ownership'
import type {
  WorkerDispatchListState,
  WorkerTerminalResourceRow,
  WorkerTerminalListState
} from '../../worker-terminal-ownership'
import { isEquivalentPaneKey } from '../pane-key-match'
import type { OrchestrationDb } from '../orchestration-db'

// Real user input relinquishes orchestration ownership durably; programmatic prompt delivery,
// query auto-replies, resize, and output never reach this path.
export function markWorkerTerminalUserOwned(this: OrchestrationDb, paneKey: string): number {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const exact = this.db
      .prepare(
        `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
          WHERE pane_key = ? AND ownership_state = 'owned'
            AND release_state IN ('not_requested', 'retained', 'requested')
            AND NOT EXISTS (
              SELECT 1 FROM worker_dispatches w
               WHERE w.dispatch_id = owner_dispatch_id AND w.state = 'stopping'
            )`
      )
      .all(paneKey) as { id: string; owner_dispatch_id: string; pane_key: string }[]
    const candidates =
      exact.length > 0
        ? exact
        : (
            this.db
              .prepare(
                `SELECT id, owner_dispatch_id, pane_key FROM worker_terminal_resources
                WHERE ownership_state = 'owned'
                  AND release_state IN ('not_requested', 'retained', 'requested')
                  AND NOT EXISTS (
                    SELECT 1 FROM worker_dispatches w
                     WHERE w.dispatch_id = owner_dispatch_id AND w.state = 'stopping'
                  )
                  AND pane_key IS NOT NULL`
              )
              .all() as { id: string; owner_dispatch_id: string; pane_key: string }[]
          ).filter((candidate) => isEquivalentPaneKey(candidate.pane_key, paneKey))
    const update = this.db.prepare(
      `UPDATE worker_terminal_resources
       SET ownership_state = 'user_owned', release_state = 'retained',
           retained_reason = 'user_takeover', updated_at = datetime('now')
       WHERE id = ? AND ownership_state = 'owned'
         AND release_state IN ('not_requested', 'retained', 'requested')
         AND NOT EXISTS (
           SELECT 1 FROM worker_dispatches w
            WHERE w.dispatch_id = owner_dispatch_id AND w.state = 'stopping'
         )`
    )
    let changed = 0
    for (const candidate of candidates) {
      const result = Number(update.run(candidate.id).changes)
      if (result > 0) {
        this.db
          .prepare('DELETE FROM worker_terminal_archives WHERE dispatch_id = ?')
          .run(candidate.owner_dispatch_id)
        changed += result
      }
    }
    this.db.exec('COMMIT')
    return changed
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

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

export function listWorkerTerminalResources(
  this: OrchestrationDb,
  params: { runId?: string } = {}
): {
  dispatchId: string
  taskId: string
  runId: string
  workerState: WorkerDispatchListState
  dispatchStatus: DispatchStatus
  agentTerminalHandle: string | null
  terminalState: WorkerTerminalListState | null
  resource: WorkerTerminalResourceRow | null
}[] {
  const rows = this.db
    .prepare(
      `SELECT d.id AS dispatch_id,
              COALESCE(w.state, 'unsupervised') AS worker_state,
              COALESCE(w.agent_terminal_handle, d.assignee_handle) AS agent_terminal_handle,
              d.task_id, d.run_id, d.status AS dispatch_status
         FROM dispatch_contexts d
         LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
        ${params.runId ? 'WHERE d.run_id = ?' : ''}
        ORDER BY COALESCE(w.created_at, d.created_at) ASC`
    )
    .all(...(params.runId ? [params.runId] : [])) as {
    dispatch_id: string
    worker_state: WorkerDispatchListState
    agent_terminal_handle: string | null
    task_id: string
    run_id: string
    dispatch_status: DispatchStatus
  }[]
  const resources = this.db
    .prepare(
      `SELECT r.* FROM worker_terminal_resources r
         JOIN dispatch_contexts d ON d.id = r.owner_dispatch_id
        ${params.runId ? 'WHERE d.run_id = ?' : ''}`
    )
    .all(...(params.runId ? [params.runId] : [])) as WorkerTerminalResourceRow[]
  const resourceByOwner = new Map(
    resources.map((resource) => [resource.owner_dispatch_id, resource])
  )
  return rows.map((row) => {
    const resource = resourceByOwner.get(row.dispatch_id) ?? null
    return {
      dispatchId: row.dispatch_id,
      taskId: row.task_id,
      runId: row.run_id,
      workerState: row.worker_state,
      dispatchStatus: row.dispatch_status,
      agentTerminalHandle: row.agent_terminal_handle,
      terminalState: deriveWorkerTerminalListState({
        workerState: row.worker_state,
        agentTerminalHandle: row.agent_terminal_handle,
        resource
      }),
      resource
    }
  })
}

export type WorkerTerminalListingMethods = {
  markWorkerTerminalUserOwned: typeof markWorkerTerminalUserOwned
  listWorkerTerminalReleaseBacklog: typeof listWorkerTerminalReleaseBacklog
  listWorkerTerminalResources: typeof listWorkerTerminalResources
}

export function attachWorkerTerminalListing(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    markWorkerTerminalUserOwned,
    listWorkerTerminalReleaseBacklog,
    listWorkerTerminalResources
  })
}
