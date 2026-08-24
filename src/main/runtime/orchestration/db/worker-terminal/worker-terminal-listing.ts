import type { DispatchStatus } from '../../types'
import { deriveWorkerTerminalListState } from '../../worker-terminal-ownership'
import type {
  WorkerDispatchListState,
  WorkerTerminalResourceRow,
  WorkerTerminalListState
} from '../../worker-terminal-ownership'
import { isEquivalentPaneKey } from '../pane-key-match'
import { exposeUtcTimestamp } from '../utc-timestamp'
import type { OrchestrationDb } from '../orchestration-db'

/** Whether this host can state how long ago the Dispatch last reported. */
export type DispatchHeartbeatState =
  /** No heartbeat has ever been recorded for this Dispatch. */
  | 'never'
  /** `heartbeatAgeSeconds` is a trustworthy age. */
  | 'recorded'
  /** A stamp exists but no age can be derived from it — corrupt, or written by a clock ahead of this one. */
  | 'unreadable'

// Why: `last_heartbeat_at` is arrival time on the Run home, never the worker's own clock — see the
// contract on recordHeartbeat — so age is a single-clock subtraction and needs no skew correction.
// The reference instant is bound rather than `julianday('now')`: `now` is only stable within one
// sqlite3_step(), so a multi-row fleet listing would age each lane against its own clock reading.
// Left unrounded on purpose — the caller must test the sign before rounding.
const HEARTBEAT_AGE_SECONDS_SQL = `(julianday(?) - julianday(d.last_heartbeat_at)) * 86400.0`

function deriveHeartbeatFreshness(row: {
  last_heartbeat_at: string | null
  heartbeat_age_seconds_exact: number | null
}): {
  lastHeartbeatReceivedAt: string | null
  heartbeatAgeSeconds: number | null
  heartbeatState: DispatchHeartbeatState
} {
  if (row.last_heartbeat_at === null) {
    return { lastHeartbeatReceivedAt: null, heartbeatAgeSeconds: null, heartbeatState: 'never' }
  }
  // Why: the stamp is still published unusable so an operator can see what is actually stored;
  // only the state says whether the age may be thresholded on.
  const lastHeartbeatReceivedAt = exposeUtcTimestamp(row.last_heartbeat_at)
  const exactAgeSeconds = row.heartbeat_age_seconds_exact
  // Why: the sign test must come before rounding. Rounding first turns any stamp under half a second
  // into this host's future into 0, publishing the most reassuring possible answer — "just reported" —
  // for a lane whose clock evidence is broken and which may in fact be hung.
  if (exactAgeSeconds === null || exactAgeSeconds < 0) {
    return { lastHeartbeatReceivedAt, heartbeatAgeSeconds: null, heartbeatState: 'unreadable' }
  }
  return {
    lastHeartbeatReceivedAt,
    heartbeatAgeSeconds: Math.round(exactAgeSeconds),
    heartbeatState: 'recorded'
  }
}

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
  lastHeartbeatReceivedAt: string | null
  heartbeatAgeSeconds: number | null
  heartbeatState: DispatchHeartbeatState
  resource: WorkerTerminalResourceRow | null
}[] {
  const rows = this.db
    .prepare(
      `SELECT d.id AS dispatch_id,
              COALESCE(w.state, 'unsupervised') AS worker_state,
              COALESCE(w.agent_terminal_handle, d.assignee_handle) AS agent_terminal_handle,
              d.task_id, d.run_id, d.status AS dispatch_status,
              d.last_heartbeat_at,
              ${HEARTBEAT_AGE_SECONDS_SQL} AS heartbeat_age_seconds_exact
         FROM dispatch_contexts d
         LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
        ${params.runId ? 'WHERE d.run_id = ?' : ''}
        ORDER BY COALESCE(w.created_at, d.created_at) ASC`
    )
    // Why: one reference instant for the whole listing, so two lanes that reported together cannot
    // read as different ages just because SQLite re-read its clock between rows.
    .all(new Date().toISOString(), ...(params.runId ? [params.runId] : [])) as {
    dispatch_id: string
    worker_state: WorkerDispatchListState
    agent_terminal_handle: string | null
    task_id: string
    run_id: string
    dispatch_status: DispatchStatus
    last_heartbeat_at: string | null
    heartbeat_age_seconds_exact: number | null
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
      ...deriveHeartbeatFreshness(row),
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
