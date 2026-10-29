import { afterEach, vi } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import type { TaskRuntimeLineageRow } from './orchestration/db/run-list-page'
import type { CoordinatorRun, DispatchContextRow, RunRow } from './orchestration/types'

const databases = new Set<OrchestrationDb>()
const createdAt = '2026-10-27T12:00:00Z'

afterEach(() => {
  for (const db of databases) {
    db.close()
  }
  databases.clear()
})

export function makeRuntimeOrchestrationDb(): OrchestrationDb {
  const db = new OrchestrationDb(':memory:')
  databases.add(db)
  // These scenarios project supplied terminal contexts even without persisted Dispatches.
  vi.spyOn(db, 'hasAnyDispatchContexts').mockReturnValue(true)
  return db
}

export function dispatchContextRow(fields: Partial<DispatchContextRow>): DispatchContextRow {
  return {
    id: 'fixture-dispatch',
    run_id: 'fixture-run',
    task_id: 'fixture-task',
    contract_version: 0,
    launch_token_hash: null,
    assignee_handle: null,
    assignee_pane_key: null,
    assignee_orca_session_id: null,
    capability_hash: null,
    process_incarnation: null,
    capability_revoked_at: null,
    retry_of_dispatch_id: null,
    creator_dispatch_id: null,
    creator_handle: null,
    creator_pane_key: null,
    creator_orca_session_id: null,
    host_scope: null,
    status: 'dispatched',
    failure_count: 0,
    last_failure: null,
    termination_reason: null,
    depth: 1,
    consumer_generation: 0,
    dispatched_at: createdAt,
    completed_at: null,
    created_at: createdAt,
    last_heartbeat_at: null,
    ...fields
  }
}

export function taskLineageRow(fields: Partial<TaskRuntimeLineageRow>): TaskRuntimeLineageRow {
  return {
    id: 'fixture-task',
    run_id: 'fixture-run',
    parent_id: null,
    created_by_terminal_handle: null,
    created_by_pane_key: null,
    created_by_process_incarnation: null,
    created_by_run_generation: null,
    task_title: null,
    display_name: null,
    spec: '',
    status: 'ready',
    deps: '[]',
    result: null,
    created_at: createdAt,
    completed_at: null,
    creator_dispatch_id: null,
    creator_dispatch_run_id: null,
    creator_dispatch_pane_key: null,
    creator_dispatch_process_incarnation: null,
    ...fields
  }
}

export function runRow(fields: Partial<RunRow>): RunRow {
  return {
    id: 'fixture-run',
    objective: '',
    home_database: 'this_database',
    coordinator_handle: null,
    coordinator_pane_key: null,
    coordinator_orca_session_id: null,
    coordinator_orca_session_id_generation: null,
    consumer_generation: 0,
    legacy: 0,
    created_at: createdAt,
    updated_at: createdAt,
    ...fields
  }
}

export function coordinatorRunRow(fields: Partial<CoordinatorRun>): CoordinatorRun {
  return {
    id: 'fixture-coordinator',
    spec: '',
    status: 'running',
    coordinator_handle: 'term_fixture',
    poll_interval_ms: 2000,
    created_at: createdAt,
    completed_at: null,
    scheduler_lost_at: null,
    ...fields
  }
}
