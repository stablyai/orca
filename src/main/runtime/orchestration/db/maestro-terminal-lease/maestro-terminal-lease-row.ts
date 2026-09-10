import type {
  MaestroTerminalCleanupReceipt,
  MaestroTerminalLaunchProfile,
  MaestroTerminalLease,
  MaestroTerminalLeaseObservation,
  MaestroTerminalLeaseRole,
  MaestroTerminalLeaseState,
  MaestroTerminalRetentionPolicy
} from '../../../../../shared/maestro-terminal-lease'
import type { OrchestrationDb } from '../orchestration-db'

export type MaestroTerminalLeaseRow = {
  id: string
  request_id: string
  execution_host_id: string
  workspace_key: string
  terminal_handle: string | null
  tab_id: string | null
  pane_key: string | null
  pty_incarnation: string | null
  process_root_id: string | null
  run_id: string
  task_id: string | null
  attempt_id: string | null
  coordinator_generation: number | null
  role: MaestroTerminalLeaseRole
  worker_terminal_resource_id: string | null
  coordinator_run_id: string | null
  title: string
  launch_profile_json: string
  parent_lease_id: string | null
  spawned_by: string
  owner_principal: string
  retention_policy: MaestroTerminalRetentionPolicy
  lifecycle_state: MaestroTerminalLeaseState
  observation: MaestroTerminalLeaseObservation | null
  provider_session_id: string | null
  capsule_digest: string | null
  cleanup_receipt_json: string | null
  archived_tail: string | null
  created_at: string
  updated_at: string
}

export function getMaestroTerminalLeaseRow(
  db: OrchestrationDb,
  column: string,
  value: string
): MaestroTerminalLeaseRow | undefined {
  return db.db.prepare(`SELECT * FROM maestro_terminal_leases WHERE ${column} = ?`).get(value) as
    | MaestroTerminalLeaseRow
    | undefined
}

export function deserializeMaestroTerminalLease(
  row: MaestroTerminalLeaseRow
): MaestroTerminalLease {
  return {
    id: row.id,
    requestId: row.request_id,
    executionHostId: row.execution_host_id,
    workspaceKey: row.workspace_key,
    terminalHandle: row.terminal_handle,
    tabId: row.tab_id,
    paneKey: row.pane_key,
    ptyIncarnation: row.pty_incarnation,
    processRootId: row.process_root_id,
    runId: row.run_id,
    taskId: row.task_id,
    attemptId: row.attempt_id,
    coordinatorGeneration: row.coordinator_generation,
    role: row.role,
    workerTerminalResourceId: row.worker_terminal_resource_id,
    coordinatorRunId: row.coordinator_run_id,
    title: row.title,
    launchProfile: JSON.parse(row.launch_profile_json) as MaestroTerminalLaunchProfile,
    parentLeaseId: row.parent_lease_id,
    spawnedBy: row.spawned_by,
    ownerPrincipal: row.owner_principal,
    retentionPolicy: row.retention_policy,
    lifecycleState: row.lifecycle_state,
    observation: row.observation,
    providerSessionId: row.provider_session_id,
    capsuleDigest: row.capsule_digest,
    cleanupReceipt: row.cleanup_receipt_json
      ? (JSON.parse(row.cleanup_receipt_json) as MaestroTerminalCleanupReceipt)
      : null,
    archivedTail: row.archived_tail,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function findLiveTerminalLeaseOwner(
  db: OrchestrationDb,
  identity: {
    leaseId: string
    executionHostId: string
    workspaceKey: string
    terminalHandle: string
    ptyIncarnation: string
  }
): { id: string } | undefined {
  return db.db
    .prepare(
      `SELECT id FROM maestro_terminal_leases
       WHERE execution_host_id = ? AND workspace_key = ? AND terminal_handle = ?
         AND pty_incarnation = ? AND id != ?
         AND lifecycle_state NOT IN ('released', 'superseded', 'archived')`
    )
    .get(
      identity.executionHostId,
      identity.workspaceKey,
      identity.terminalHandle,
      identity.ptyIncarnation,
      identity.leaseId
    ) as { id: string } | undefined
}
