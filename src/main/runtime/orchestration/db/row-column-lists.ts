import type { AttemptObservationStorageRow } from './attempt-observation-store'
import type { DispatchContextRow, RemoteDispatchAttachmentRow, RunRow, TaskRow } from '../types'

// Explicit projections enable SyncDatabase caching; type exhaustiveness and schema tests prevent column drift.

export const RUN_COLUMNS = [
  'id',
  'objective',
  'home_database',
  'coordinator_handle',
  'coordinator_pane_key',
  'coordinator_orca_session_id',
  'coordinator_orca_session_id_generation',
  'consumer_generation',
  'legacy',
  'created_at',
  'updated_at'
] as const satisfies readonly (keyof RunRow)[]

export const TASK_COLUMNS = [
  'id',
  'run_id',
  'parent_id',
  'created_by_terminal_handle',
  'created_by_pane_key',
  'created_by_process_incarnation',
  'created_by_run_generation',
  'task_title',
  'display_name',
  'spec',
  'status',
  'deps',
  'result',
  'created_at',
  'completed_at'
] as const satisfies readonly (keyof TaskRow)[]

export const DISPATCH_CONTEXT_COLUMNS = [
  'id',
  'run_id',
  'task_id',
  'contract_version',
  'launch_token_hash',
  'assignee_handle',
  'assignee_pane_key',
  'assignee_orca_session_id',
  'capability_hash',
  'process_incarnation',
  'capability_revoked_at',
  'retry_of_dispatch_id',
  'creator_dispatch_id',
  'creator_handle',
  'creator_pane_key',
  'creator_orca_session_id',
  'host_scope',
  'status',
  'failure_count',
  'last_failure',
  'termination_reason',
  'depth',
  'consumer_generation',
  'dispatched_at',
  'completed_at',
  'created_at',
  'last_heartbeat_at',
  'follow_up_of_dispatch_id',
  'follow_up_mail_at'
] as const satisfies readonly (keyof DispatchContextRow)[]

export const ATTEMPT_OBSERVATION_FACT_COLUMNS = [
  'id',
  'dispatch_id',
  'task_id',
  'sequence',
  'authority_id',
  'authority_clock',
  'facet',
  'payload',
  'source_observed_at',
  'execution_received_at',
  'home_received_at',
  'created_at'
] as const satisfies readonly (keyof AttemptObservationStorageRow)[]

export const REMOTE_DISPATCH_ATTACHMENT_COLUMNS = [
  'home_run_id',
  'dispatch_id',
  'task_id',
  'home_peer_fingerprint',
  'protocol_version',
  'runtime_epoch',
  'capability_hash',
  'pane_key',
  'process_incarnation',
  'state',
  'stage',
  'worktree_id',
  'terminal_handle',
  'setup_state',
  'effects',
  'residual_resources',
  'to_worker_imported_sequence',
  'depth',
  'consumer_generation',
  'last_error',
  'created_at',
  'updated_at'
] as const satisfies readonly (keyof RemoteDispatchAttachmentRow)[]

// Fail compilation if a row field is missing from its projection.
type UnprojectedRunColumn = Exclude<keyof RunRow, (typeof RUN_COLUMNS)[number]>
type UnprojectedTaskColumn = Exclude<keyof TaskRow, (typeof TASK_COLUMNS)[number]>
type UnprojectedDispatchContextColumn = Exclude<
  keyof DispatchContextRow,
  (typeof DISPATCH_CONTEXT_COLUMNS)[number]
>
type UnprojectedAttemptObservationColumn = Exclude<
  keyof AttemptObservationStorageRow,
  (typeof ATTEMPT_OBSERVATION_FACT_COLUMNS)[number]
>
type UnprojectedRemoteDispatchAttachmentColumn = Exclude<
  keyof RemoteDispatchAttachmentRow,
  (typeof REMOTE_DISPATCH_ATTACHMENT_COLUMNS)[number]
>
const assertEveryRowColumnProjected: [
  UnprojectedRunColumn extends never ? true : never,
  UnprojectedTaskColumn extends never ? true : never,
  UnprojectedDispatchContextColumn extends never ? true : never,
  UnprojectedAttemptObservationColumn extends never ? true : never,
  UnprojectedRemoteDispatchAttachmentColumn extends never ? true : never
] = [true, true, true, true, true]
void assertEveryRowColumnProjected

/** Projection list for a `SELECT`; `alias` qualifies each name for a joined table (`t.id, …`). */
export function selectColumns(columns: readonly string[], alias?: string): string {
  return columns.map((column) => (alias ? `${alias}.${column}` : column)).join(', ')
}

export const RUN_COLUMN_LIST = selectColumns(RUN_COLUMNS)
export const DISPATCH_CONTEXT_COLUMN_LIST = selectColumns(DISPATCH_CONTEXT_COLUMNS)
export const ATTEMPT_OBSERVATION_FACT_COLUMN_LIST = selectColumns(ATTEMPT_OBSERVATION_FACT_COLUMNS)
export const REMOTE_DISPATCH_ATTACHMENT_COLUMN_LIST = selectColumns(
  REMOTE_DISPATCH_ATTACHMENT_COLUMNS
)
