import type { AttemptObservationStorageRow } from './attempt-observation-store'
import type { DispatchContextRow, RunRow, TaskRow } from '../types'

// Why: `SyncDatabase` refuses to cache any `SELECT *` (node:sqlite can build the first row after a
// schema change from stale column names), so a wildcard read recompiles its SQL on every call.
// Spelling the projection out makes the hot-path statements cacheable by that existing LRU.
// Drift is caught twice: `satisfies` + the exhaustiveness assertions below pin list↔type at tsc,
// and `row-column-lists.test.ts` pins list↔schema against a freshly migrated database.

export const RUN_COLUMNS = [
  'id',
  'objective',
  'home_database',
  'coordinator_handle',
  'coordinator_pane_key',
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
  'capability_hash',
  'process_incarnation',
  'capability_revoked_at',
  'retry_of_dispatch_id',
  'creator_dispatch_id',
  'creator_handle',
  'creator_pane_key',
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
  'last_heartbeat_at'
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

// Compile check: a row field added without its column here would silently vanish from the
// projection that used to be `SELECT *`, so the missing key must fail the build.
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
const assertEveryRowColumnProjected: [
  UnprojectedRunColumn extends never ? true : never,
  UnprojectedTaskColumn extends never ? true : never,
  UnprojectedDispatchContextColumn extends never ? true : never,
  UnprojectedAttemptObservationColumn extends never ? true : never
] = [true, true, true, true]
void assertEveryRowColumnProjected

/** Projection list for a `SELECT`; `alias` qualifies each name for a joined table (`t.id, …`). */
export function selectColumns(columns: readonly string[], alias?: string): string {
  return columns.map((column) => (alias ? `${alias}.${column}` : column)).join(', ')
}

export const RUN_COLUMN_LIST = selectColumns(RUN_COLUMNS)
export const DISPATCH_CONTEXT_COLUMN_LIST = selectColumns(DISPATCH_CONTEXT_COLUMNS)
export const ATTEMPT_OBSERVATION_FACT_COLUMN_LIST = selectColumns(ATTEMPT_OBSERVATION_FACT_COLUMNS)
