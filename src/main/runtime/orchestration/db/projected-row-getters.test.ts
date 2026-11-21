// The three hot point getters read explicit projections so SyncDatabase can keep their compiled
// statements; these tests pin the rows they return (literal values, never a mirror query) across
// writes, rollback, savepoints, reopen and DDL.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../../sqlite/sync-database'
import { OrchestrationDb } from './orchestration-db'

const opened: OrchestrationDb[] = []
const directories: string[] = []

afterEach(() => {
  opened.splice(0).forEach((db) => db.close())
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }))
})

function openDb(path = ':memory:'): OrchestrationDb {
  const db = new OrchestrationDb(path)
  opened.push(db)
  return db
}

function fileDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'orca-projected-getters-'))
  directories.push(directory)
  return join(directory, 'orchestration.db')
}

/** Hand-written rows: a full one with nulls and integers, a minimal one on defaults, and two terminal
 *  resources sharing an incarnation so the newest-first tie order is observable. */
function seed(db: OrchestrationDb): void {
  db.db.exec('BEGIN')
  db.db
    .prepare(
      `INSERT INTO runs (id, objective, coordinator_handle, coordinator_pane_key)
       VALUES ('run-1', 'demo', 'term_c', 'tab_c:leaf_c')`
    )
    .run()
  db.db
    .prepare(
      `INSERT INTO tasks (id, run_id, spec, task_title, status)
       VALUES ('t-full', 'run-1', 'spec', 'Full task', 'dispatched'),
         ('t-min', 'run-1', 'spec', NULL, 'completed')`
    )
    .run()
  db.db
    .prepare(
      `INSERT INTO dispatch_contexts (id, run_id, task_id, contract_version, status, assignee_handle,
         assignee_pane_key, assignee_orca_session_id, process_incarnation, creator_orca_session_id,
         creator_pane_key, last_failure, failure_count, depth, dispatched_at, completed_at,
         creator_turn_source, created_at)
       VALUES ('d-full', 'run-1', 't-full', 1, 'dispatched', 'term_full', 'tab-a:pane-1', 'sess-full',
         'proc-full', 'chat-1', 'tab-c:pane-2', 'stopped', 2, 2, '2026-11-10 10:00:00', NULL,
         'connector', '2026-11-10 09:00:00')`
    )
    .run()
  db.db
    .prepare(
      `INSERT INTO dispatch_contexts (id, run_id, task_id, contract_version, status, depth, created_at)
       VALUES ('d-min', 'run-1', 't-min', 1, 'completed', 0, '2026-11-10 09:00:00')`
    )
    .run()
  db.db
    .prepare(
      `INSERT INTO worker_dispatches (dispatch_id, runtime_epoch, state, stage, worktree_id,
         agent_terminal_handle, start_options, last_error, created_at, updated_at)
       VALUES ('d-full', 'epoch-1', 'ready', 'running', 'wt-1', 'term_full',
         '{"agent":"claude","n":9007199254740993}', NULL, '2026-11-10 09:00:00', '2026-11-10 09:00:00')`
    )
    .run()
  db.db
    .prepare(
      `INSERT INTO worker_dispatches (dispatch_id, created_at, updated_at)
       VALUES ('d-min', '2026-11-10 09:00:00', '2026-11-10 09:00:00')`
    )
    .run()
  db.db
    .prepare(
      `INSERT INTO worker_terminal_resources (id, origin_dispatch_id, owner_dispatch_id, terminal_handle,
         pane_key, process_incarnation, worktree_id, recovery_attempt_count, created_at, updated_at)
       VALUES ('r-old', 'd-full', 'd-old', 'term_old', 'p-old', 'proc-full', 'wt-0', 0,
           '2026-11-09 00:00:00', '2026-11-09 00:00:00'),
         ('r-new', 'd-full', 'd-full', 'term_full', 'p-new', 'proc-full', 'wt-1', 3,
           '2026-11-10 00:00:00', '2026-11-10 00:00:00')`
    )
    .run()
  db.db.exec('COMMIT')
}

const FULL_DISPATCH = {
  id: 'd-full',
  run_id: 'run-1',
  task_id: 't-full',
  contract_version: 1,
  launch_token_hash: null,
  assignee_handle: 'term_full',
  assignee_pane_key: 'tab-a:pane-1',
  assignee_orca_session_id: 'sess-full',
  capability_hash: null,
  process_incarnation: 'proc-full',
  capability_revoked_at: null,
  retry_of_dispatch_id: null,
  creator_dispatch_id: null,
  creator_handle: null,
  creator_pane_key: 'tab-c:pane-2',
  creator_orca_session_id: 'chat-1',
  host_scope: null,
  status: 'dispatched',
  failure_count: 2,
  last_failure: 'stopped',
  termination_reason: null,
  depth: 2,
  consumer_generation: 0,
  dispatched_at: '2026-11-10 10:00:00',
  completed_at: null,
  created_at: '2026-11-10 09:00:00',
  last_heartbeat_at: null,
  follow_up_of_dispatch_id: null,
  follow_up_mail_at: null,
  creator_turn_source: 'connector',
  origin_ref: null
}

const FULL_WORKER = {
  dispatch_id: 'd-full',
  runtime_epoch: 'epoch-1',
  state: 'ready',
  stage: 'running',
  worktree_id: 'wt-1',
  agent_terminal_handle: 'term_full',
  setup_state: 'not_applicable',
  effects: '[]',
  residual_resources: '[]',
  start_options: '{"agent":"claude","n":9007199254740993}',
  last_error: null,
  created_at: '2026-11-10 09:00:00',
  updated_at: '2026-11-10 09:00:00'
}

const NEWEST_RESOURCE = {
  id: 'r-new',
  origin_dispatch_id: 'd-full',
  owner_dispatch_id: 'd-full',
  prior_owner_dispatch_ids: '[]',
  worktree_id: 'wt-1',
  terminal_handle: 'term_full',
  pane_key: 'p-new',
  process_incarnation: 'proc-full',
  endpoint_id: null,
  endpoint_incarnation: null,
  host_scope: null,
  ownership_state: 'owned',
  release_state: 'not_requested',
  retained_reason: null,
  release_requested_at: null,
  release_completed_at: null,
  release_error: null,
  recovery_attempt_count: 3,
  last_recovery_at: null,
  archive_source: null,
  archive_status: null,
  auto_release_at: null,
  auto_release_dispatch_id: null,
  created_at: '2026-11-10 00:00:00',
  updated_at: '2026-11-10 00:00:00',
  resume_session: null
}

function expectSeededRows(db: OrchestrationDb): void {
  expect(db.getDispatchContextById('d-full')).toEqual(FULL_DISPATCH)
  expect(db.getWorkerDispatch('d-full')).toEqual(FULL_WORKER)
  expect(db.getWorkerTerminalResourceByProcessIncarnation('proc-full')).toEqual(NEWEST_RESOURCE)
}

describe('projected row getters', () => {
  it('return the full row with nulls, integers and JSON text, the minimal row on defaults, and not-found', () => {
    const db = openDb()
    seed(db)

    expectSeededRows(db)
    expect(db.getDispatchContextById('d-min')).toEqual({
      ...Object.fromEntries(Object.keys(FULL_DISPATCH).map((column) => [column, null])),
      id: 'd-min',
      run_id: 'run-1',
      task_id: 't-min',
      contract_version: 1,
      status: 'completed',
      failure_count: 0,
      depth: 0,
      consumer_generation: 0,
      created_at: '2026-11-10 09:00:00'
    })
    expect(db.getWorkerDispatch('d-min')).toEqual({
      dispatch_id: 'd-min',
      runtime_epoch: null,
      state: 'starting',
      stage: 'accepted',
      worktree_id: null,
      agent_terminal_handle: null,
      setup_state: 'not_applicable',
      effects: '[]',
      residual_resources: '[]',
      start_options: '{}',
      last_error: null,
      created_at: '2026-11-10 09:00:00',
      updated_at: '2026-11-10 09:00:00'
    })
    expect(db.getDispatchContextById('d-missing')).toBeUndefined()
    expect(db.getWorkerDispatch('d-missing')).toBeUndefined()
    expect(db.getWorkerTerminalResourceByProcessIncarnation('proc-missing')).toBeUndefined()
  })

  it('pick the newest of two resources sharing an incarnation, and follow its updated_at', () => {
    const db = openDb()
    seed(db)

    expect(db.getWorkerTerminalResourceByProcessIncarnation('proc-full')?.id).toBe('r-new')
    db.db
      .prepare(
        "UPDATE worker_terminal_resources SET updated_at = '2026-11-11 00:00:00' WHERE id = 'r-old'"
      )
      .run()
    expect(db.getWorkerTerminalResourceByProcessIncarnation('proc-full')).toEqual({
      ...NEWEST_RESOURCE,
      id: 'r-old',
      owner_dispatch_id: 'd-old',
      terminal_handle: 'term_old',
      pane_key: 'p-old',
      worktree_id: 'wt-0',
      recovery_attempt_count: 0,
      created_at: '2026-11-09 00:00:00',
      updated_at: '2026-11-11 00:00:00'
    })
  })

  it('read an update at once, and the original again after ROLLBACK and ROLLBACK TO', () => {
    const db = openDb()
    seed(db)

    db.db
      .prepare("UPDATE worker_dispatches SET state = 'succeeded' WHERE dispatch_id = 'd-full'")
      .run()
    db.db.prepare("UPDATE dispatch_contexts SET status = 'completed' WHERE id = 'd-full'").run()
    expect(db.getWorkerDispatch('d-full')).toEqual({ ...FULL_WORKER, state: 'succeeded' })
    expect(db.getDispatchContextById('d-full')).toEqual({ ...FULL_DISPATCH, status: 'completed' })

    db.db.exec('BEGIN')
    db.db
      .prepare("UPDATE worker_dispatches SET state = 'failed' WHERE dispatch_id = 'd-full'")
      .run()
    expect(db.getWorkerDispatch('d-full')?.state).toBe('failed')
    db.db.exec('ROLLBACK')
    expect(db.getWorkerDispatch('d-full')).toEqual({ ...FULL_WORKER, state: 'succeeded' })

    db.db.exec('SAVEPOINT probe')
    db.db
      .prepare("UPDATE dispatch_contexts SET last_failure = 'abandoned' WHERE id = 'd-full'")
      .run()
    db.db
      .prepare("UPDATE worker_terminal_resources SET pane_key = 'p-moved' WHERE id = 'r-new'")
      .run()
    expect(db.getDispatchContextById('d-full')?.last_failure).toBe('abandoned')
    expect(db.getWorkerTerminalResourceByProcessIncarnation('proc-full')?.pane_key).toBe('p-moved')
    db.db.exec('ROLLBACK TO probe')
    db.db.exec('RELEASE probe')
    expect(db.getDispatchContextById('d-full')).toEqual({ ...FULL_DISPATCH, status: 'completed' })
    expect(db.getWorkerTerminalResourceByProcessIncarnation('proc-full')).toEqual(NEWEST_RESOURCE)
  })

  it('return the same rows after local and external DDL and after reopening', () => {
    const path = fileDbPath()
    const db = openDb(path)
    seed(db)
    expectSeededRows(db)

    db.db.exec('ALTER TABLE worker_terminal_resources ADD COLUMN probe_here TEXT')
    expectSeededRows(db)

    // Another connection's DDL is invisible to this connection's cache; SQLite re-prepares the statement.
    const other = new SyncDatabase(path)
    other.exec('ALTER TABLE worker_dispatches ADD COLUMN probe_elsewhere TEXT')
    other.close()
    expectSeededRows(db)
    expect(db.getWorkerDispatch('d-min')?.state).toBe('starting')

    db.close()
    opened.pop()
    expectSeededRows(openDb(path))
  })
})
