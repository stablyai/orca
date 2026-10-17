import type { OrchestrationDb } from '../orchestration-db'

export const MAX_ROWS_PER_KIND = 128

export type ScopeKind =
  | 'tasks'
  | 'dispatches'
  | 'workers'
  | 'resources'
  | 'federatedWorkers'
  | 'remoteAttachments'
  | 'archives'
  | 'livenessObservations'

type ScopeSection = { total: number; rows: Record<string, unknown>[] }
export type ResetScope = Record<ScopeKind, ScopeSection>

const SCOPE_QUERIES: Record<ScopeKind, string> = {
  tasks: `SELECT id, run_id, parent_id, created_by_terminal_handle,
      created_by_pane_key, created_by_process_incarnation, created_by_run_generation,
      deps, status, created_at FROM tasks WHERE run_id = ? ORDER BY id`,
  dispatches: `SELECT id, run_id, task_id, retry_of_dispatch_id, creator_dispatch_id,
      creator_handle, creator_pane_key, creator_orca_session_id, assignee_handle,
      assignee_pane_key, assignee_orca_session_id, process_incarnation, host_scope,
      status, depth, created_at FROM dispatch_contexts WHERE run_id = ? ORDER BY id`,
  workers: `SELECT w.dispatch_id, w.runtime_epoch, w.state, w.stage, w.worktree_id,
      w.agent_terminal_handle, w.setup_state, w.created_at
      FROM worker_dispatches w JOIN dispatch_contexts d ON d.id = w.dispatch_id
      WHERE d.run_id = ? ORDER BY w.dispatch_id`,
  resources: `SELECT r.id, r.origin_dispatch_id, r.owner_dispatch_id,
      r.prior_owner_dispatch_ids, r.worktree_id, r.terminal_handle, r.pane_key,
      r.process_incarnation, r.endpoint_id, r.endpoint_incarnation, r.host_scope,
      r.ownership_state, r.release_state, r.created_at
      FROM worker_terminal_resources r WHERE EXISTS (
        SELECT 1 FROM dispatch_contexts d WHERE d.run_id = ?
          AND d.id IN (r.origin_dispatch_id, r.owner_dispatch_id)
      ) OR EXISTS (
        SELECT 1 FROM remote_dispatch_attachments a WHERE a.home_run_id = ?
          AND a.dispatch_id IN (r.origin_dispatch_id, r.owner_dispatch_id)
      ) ORDER BY r.id`,
  federatedWorkers: `SELECT f.dispatch_id, f.environment_id, f.environment_name,
      f.peer_fingerprint, f.remote_runtime_epoch, f.remote_worktree_id,
      f.remote_terminal_handle, f.created_at
      FROM federated_dispatches f JOIN dispatch_contexts d ON d.id = f.dispatch_id
      WHERE d.run_id = ? ORDER BY f.dispatch_id`,
  remoteAttachments: `SELECT dispatch_id, task_id, home_run_id, home_peer_fingerprint,
      runtime_epoch, pane_key, process_incarnation, state, stage, worktree_id,
      terminal_handle, setup_state, depth, created_at
      FROM remote_dispatch_attachments WHERE home_run_id = ? ORDER BY dispatch_id`,
  archives: `SELECT a.dispatch_id, a.resource_id, a.kind, a.created_at
      FROM worker_terminal_archives a WHERE EXISTS (
        SELECT 1 FROM dispatch_contexts d WHERE d.run_id = ? AND d.id = a.dispatch_id
      ) OR EXISTS (
        SELECT 1 FROM remote_dispatch_attachments r WHERE r.home_run_id = ?
          AND r.dispatch_id = a.dispatch_id
      ) ORDER BY a.dispatch_id`,
  livenessObservations: `SELECT f.id, f.dispatch_id, f.task_id, f.sequence,
      f.authority_id, f.authority_clock, f.source_observed_at,
      f.execution_received_at, f.home_received_at, f.created_at,
      json_extract(f.payload, '$.status') AS status
      FROM attempt_observation_facts f WHERE f.facet = 'liveness' AND (
        EXISTS (SELECT 1 FROM dispatch_contexts d WHERE d.run_id = ? AND d.id = f.dispatch_id)
        OR EXISTS (SELECT 1 FROM remote_dispatch_attachments a
          WHERE a.home_run_id = ? AND a.dispatch_id = f.dispatch_id)
      ) ORDER BY f.dispatch_id, f.sequence`
}

export const SCOPE_KINDS: ScopeKind[] = [
  'tasks',
  'dispatches',
  'workers',
  'resources',
  'federatedWorkers',
  'remoteAttachments',
  'archives',
  'livenessObservations'
]

function readScopeSection(db: OrchestrationDb, runId: string, kind: ScopeKind): ScopeSection {
  const sql = SCOPE_QUERIES[kind]
  const bindings =
    kind === 'resources' || kind === 'archives' || kind === 'livenessObservations'
      ? [runId, runId]
      : [runId]
  const count = db.db.prepare(`SELECT COUNT(*) AS total FROM (${sql})`).get(...bindings)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: COUNT(*) always returns one numeric total row.
  const total = (count as { total: number }).total
  const rows = db.db.prepare(`${sql} LIMIT ?`).all(...bindings, MAX_ROWS_PER_KIND)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Each fixed SELECT above projects plain SQLite row objects.
  return { total, rows: rows as Record<string, unknown>[] }
}

export function readResetScope(db: OrchestrationDb, runId: string): ResetScope {
  return {
    tasks: readScopeSection(db, runId, 'tasks'),
    dispatches: readScopeSection(db, runId, 'dispatches'),
    workers: readScopeSection(db, runId, 'workers'),
    resources: readScopeSection(db, runId, 'resources'),
    federatedWorkers: readScopeSection(db, runId, 'federatedWorkers'),
    remoteAttachments: readScopeSection(db, runId, 'remoteAttachments'),
    archives: readScopeSection(db, runId, 'archives'),
    livenessObservations: readScopeSection(db, runId, 'livenessObservations')
  }
}
