import type { OrchestrationDb } from '../orchestration-db'
import { createMaestroTerminalLeaseTablesSql } from './create-maestro-terminal-lease-tables-sql'
import {
  createMaestroTerminalLeaseIndexesIfPossible,
  createMaestroTransferMutationIndexIfPossible
} from './schema-column-probes'

export function applySchemaMigrationV41(this: OrchestrationDb, current: number): void {
  const mutationColumns = [
    'mutation_caller_fingerprint',
    'mutation_request_id',
    'mutation_method',
    'mutation_payload_hash'
  ]
  if (
    current >= 41 ||
    mutationColumns.some((column) =>
      this.hasColumn('maestro_terminal_lease_transfer_receipts', column)
    )
  ) {
    for (const column of mutationColumns) {
      if (!this.hasColumn('maestro_terminal_lease_transfer_receipts', column)) {
        this.db.exec(
          `ALTER TABLE maestro_terminal_lease_transfer_receipts ADD COLUMN ${column} TEXT`
        )
      }
    }
    createMaestroTransferMutationIndexIfPossible(this)
    createMaestroTerminalLeaseIndexesIfPossible(this)
    return
  }
  this.db.exec(`
    DROP INDEX IF EXISTS idx_maestro_terminal_leases_coordinator_generation;
    DROP INDEX IF EXISTS idx_maestro_terminal_leases_worker_attempt;
    DROP INDEX IF EXISTS idx_maestro_terminal_leases_worker_resource;
    DROP INDEX IF EXISTS idx_maestro_terminal_leases_live_terminal_owner;
    DROP INDEX IF EXISTS idx_maestro_terminal_leases_lifecycle;
    DROP INDEX IF EXISTS idx_maestro_terminal_lease_transfer_mutation;
    ALTER TABLE maestro_terminal_input_receipts RENAME TO maestro_terminal_input_receipts_v32;
    ALTER TABLE maestro_coordinator_handoff_receipts RENAME TO maestro_coordinator_handoff_receipts_v32;
    ALTER TABLE maestro_terminal_lease_transfer_receipts RENAME TO maestro_terminal_lease_transfer_receipts_v32;
    ALTER TABLE maestro_terminal_leases RENAME TO maestro_terminal_leases_v32;
  `)
  this.db.exec(createMaestroTerminalLeaseTablesSql())
  this.db.exec(`
    INSERT INTO maestro_terminal_leases (
      id, request_id, execution_host_id, workspace_key, terminal_handle, tab_id, pane_key,
      pty_incarnation, process_root_id, run_id, task_id, attempt_id, coordinator_generation,
      role, worker_terminal_resource_id, coordinator_run_id, title, launch_profile_json,
      parent_lease_id, spawned_by, owner_principal, retention_policy, lifecycle_state,
      observation, provider_session_id, capsule_digest, cleanup_receipt_json, archived_tail,
      created_at, updated_at
    ) SELECT
      id, request_id, execution_host_id, workspace_key, terminal_handle, tab_id, pane_key,
      pty_incarnation, process_root_id, run_id, task_id,
      attempt_id,
      coordinator_generation, role, worker_terminal_resource_id, coordinator_run_id, title,
      launch_profile_json, parent_lease_id, spawned_by, owner_principal, retention_policy,
      lifecycle_state, observation, provider_session_id, capsule_digest, cleanup_receipt_json,
      archived_tail, created_at, updated_at
    FROM maestro_terminal_leases_v32;
    INSERT INTO maestro_terminal_input_receipts (
      command_id, idempotency_key, content_digest, enqueue_sequence, sender_json, lease_id,
      execution_host_id, workspace_key, terminal_handle, tab_id, pty_incarnation,
      expected_lifecycle_state, observed_input_surface, expires_at, expected_graph_revision,
      state, bytes_written, enter_written, acknowledged_graph_revision, superseded_by_command_id,
      rejection_code, created_at, updated_at
    ) SELECT
      command_id, idempotency_key, content_digest, enqueue_sequence, sender_json, lease_id,
      execution_host_id, workspace_key, terminal_handle, tab_id, pty_incarnation,
      expected_lifecycle_state, observed_input_surface, expires_at, expected_graph_revision,
      state, bytes_written, enter_written, acknowledged_graph_revision, superseded_by_command_id,
      rejection_code, created_at, updated_at
    FROM maestro_terminal_input_receipts_v32;
    INSERT INTO maestro_terminal_lease_transfer_receipts (request_id, receipt_json, created_at)
    SELECT request_id, receipt_json, created_at FROM maestro_terminal_lease_transfer_receipts_v32;
    INSERT INTO maestro_coordinator_handoff_receipts (
      request_id, run_id, phase, predecessor_lease_id, successor_lease_id,
      successor_terminal_handle, successor_tab_id, successor_pty_incarnation, capsule_digest,
      input_idempotency_key, claimed_generation, expected_graph_revision, observed_graph_revision,
      blocked_code, predecessor_retained, created_at, updated_at
    ) SELECT
      request_id, run_id, phase, predecessor_lease_id, successor_lease_id,
      successor_terminal_handle, successor_tab_id, successor_pty_incarnation, capsule_digest,
      input_idempotency_key, claimed_generation, expected_graph_revision, observed_graph_revision,
      blocked_code, predecessor_retained, created_at, updated_at
    FROM maestro_coordinator_handoff_receipts_v32;
    DROP TABLE maestro_terminal_input_receipts_v32;
    DROP TABLE maestro_terminal_lease_transfer_receipts_v32;
    DROP TABLE maestro_coordinator_handoff_receipts_v32;
    DROP TABLE maestro_terminal_leases_v32;
  `)
  createMaestroTransferMutationIndexIfPossible(this)
}
