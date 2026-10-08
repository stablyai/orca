import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isOrcaSessionId } from '../../../../shared/orca-session-address'
import { OrchestrationDb } from './orchestration-db'
import { createRootDispatch } from './root-dispatch-test-fixture'
import { LEGACY_CONTRACT_VERSION } from './contract-constants'
import { DISPATCH_CONTEXT_COLUMNS } from './row-column-lists'
import { warnStaleDispatches } from '../coordinator-task-dispatch'

const databases: OrchestrationDb[] = []
const directories: string[] = []
const NOW = '2026-10-02T12:00:00.000Z'
const PANE = 'tab_worker:11111111-1111-4111-8111-111111111111'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const db of databases.splice(0)) {
    db.close()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture(count = 1, version: 'fresh' | 'v41' = 'fresh') {
  const directory = mkdtempSync(join(tmpdir(), 'orca-remaining-dispatch-compilation-'))
  directories.push(directory)
  const path = join(directory, 'orchestration.db')
  let writer = new OrchestrationDb(path)
  databases.push(writer)
  const run = writer.createRun({
    objective: 'dispatch lifecycle',
    coordinatorHandle: 'coordinator',
    coordinatorPaneKey: 'tab_coordinator:22222222-2222-4222-8222-222222222222'
  })
  const entries = Array.from({ length: count }, (_, index) => {
    const task = writer.createTask({ spec: `work ${index}`, runId: run.id })
    const pane =
      index === 0
        ? PANE
        : `tab_worker:${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`
    const dispatch = createRootDispatch(writer, task.id, `worker_${index}`, pane)
    writer.db
      .prepare('UPDATE dispatch_contexts SET status = ?, dispatched_at = ?, depth = ? WHERE id = ?')
      .run('dispatched', '2026-10-02 10:00:00', 2, dispatch.id)
    writer.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('dispatched', task.id)
    const expected = writer.db
      .prepare('SELECT * FROM dispatch_contexts WHERE id = ?')
      .get(dispatch.id)
    if (!expected) {
      throw new Error('Missing dispatch fixture')
    }
    return { task, dispatch, expected }
  })
  if (version === 'v41') {
    writer.db.exec(`
      DROP INDEX idx_runs_coordinator_orca_session_id;
      DROP INDEX idx_dispatch_assignee_orca_session_id;
      DROP TRIGGER trg_runs_remember_coordinator_insert;
      DROP TRIGGER trg_runs_remember_coordinator_update;
      DROP TRIGGER trg_messages_route_coordinator_mail;
      ALTER TABLE runs DROP COLUMN coordinator_orca_session_id;
      ALTER TABLE runs DROP COLUMN coordinator_orca_session_id_generation;
      ALTER TABLE dispatch_contexts DROP COLUMN assignee_orca_session_id;
      ALTER TABLE dispatch_contexts DROP COLUMN creator_orca_session_id;
    `)
    writer.db.pragma('user_version = 41')
    databases.pop()
    writer.close()
    writer = new OrchestrationDb(path)
    databases.push(writer)
    for (const entry of entries) {
      const migrated = writer.db
        .prepare('SELECT * FROM dispatch_contexts WHERE id = ?')
        .get(entry.dispatch.id)
      if (!migrated) {
        throw new Error('Missing migrated dispatch')
      }
      entry.expected = migrated
    }
  }
  expect(
    writer.db
      .prepare('PRAGMA table_info(dispatch_contexts)')
      .all()
      .map((row) => row.name)
      .toSorted()
  ).toEqual(DISPATCH_CONTEXT_COLUMNS.toSorted())
  const reader = new OrchestrationDb(path)
  databases.push(reader)
  return { writer, reader, run, entries }
}

function fullDispatchReads(calls: [string, ...unknown[]][]): string[] {
  return calls
    .map(([sql]) => sql)
    .filter(
      (sql) =>
        /SELECT (?:\*|id, run_id, task_id, contract_version,)/.test(sql) &&
        sql.includes('FROM dispatch_contexts')
    )
}

describe('remaining dispatch metadata statement compilation', () => {
  it.each(['fresh', 'v41'] as const)(
    'reuses stale and direct-owner reads with exact rows, rebinding, plans and cross-connection freshness (%s)',
    (version) => {
      const {
        writer,
        reader,
        run,
        entries: [{ dispatch, expected }]
      } = fixture(1, version)
      vi.useFakeTimers()
      vi.setSystemTime(new Date(NOW))
      const compile = vi.spyOn(DatabaseSync.prototype, 'prepare')
      for (let call = 0; call < 10; call += 1) {
        expect(reader.getStaleDispatches('2026-10-02T11:00:00Z')).toEqual([expected])
        expect(reader.getStaleDispatches('2026-10-02T09:00:00Z')).toEqual([])
        expect(reader.findActiveDispatchForDirectMessageOwner(run.id, 'worker_0')).toEqual(expected)
        expect(reader.findActiveDispatchForDirectMessageOwner(run.id, 'missing', PANE)).toEqual(
          expected
        )
        expect(
          reader.findActiveDispatchForDirectMessageOwner(
            run.id,
            'missing',
            PANE.replace('tab_worker:', 'reminted:')
          )
        ).toEqual(expected)
        expect(
          reader.findActiveDispatchForDirectMessageOwner(run.id, 'missing', 'bad:legacy')
        ).toBeUndefined()
      }
      const warnings: string[] = []
      warnStaleDispatches(reader, (warning) => warnings.push(warning))
      expect(warnings).toEqual([
        `Warning: worker worker_0 on task ${dispatch.task_id} has not sent a heartbeat in ~10 min (dispatch ${dispatch.id})`
      ])
      writer.db
        .prepare(
          'UPDATE dispatch_contexts SET last_heartbeat_at = ?, assignee_handle = ? WHERE id = ?'
        )
        .run(NOW, 'updated', dispatch.id)
      expect(reader.getStaleDispatches('2026-10-02T11:00:00Z')).toEqual([])
      expect(reader.findActiveDispatchForDirectMessageOwner(run.id, 'worker_0')).toBeUndefined()
      expect(reader.findActiveDispatchForDirectMessageOwner(run.id, 'updated')).toEqual({
        ...expected,
        last_heartbeat_at: NOW,
        assignee_handle: 'updated'
      })
      const reads = fullDispatchReads(compile.mock.calls)
      const staleSql = reads.find((sql) => sql.includes('julianday'))
      compile.mockRestore()
      if (!staleSql) {
        throw new Error('Missing stale query')
      }
      const wildcardSql = staleSql.replace(/SELECT .*? FROM/, 'SELECT * FROM')
      expect(writer.db.prepare(`EXPLAIN QUERY PLAN ${staleSql}`).all(NOW, NOW)).toEqual(
        writer.db.prepare(`EXPLAIN QUERY PLAN ${wildcardSql}`).all(NOW, NOW)
      )
      expect(reads).toHaveLength(3)
    }
  )

  it.each(['fresh', 'v41'] as const)(
    'reuses session creator reads without changing self-created parent exclusion or fresh depth (%s)',
    (version) => {
      const {
        writer,
        reader,
        entries: [{ dispatch }]
      } = fixture(1, version)
      const sessionId = '00000000-0000-4000-8000-000000000001'
      if (!isOrcaSessionId(sessionId)) {
        throw new Error('Invalid session fixture')
      }
      writer.db
        .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
        .run(sessionId, dispatch.id)
      const compile = vi.spyOn(DatabaseSync.prototype, 'prepare')
      for (let call = 0; call < 10; call += 1) {
        expect(reader.resolveCreatorDepth({ kind: 'session', orcaSessionId: sessionId })).toBe(2)
        expect(reader.resolveCreatorDispatchId({ kind: 'session', orcaSessionId: sessionId })).toBe(
          dispatch.id
        )
      }
      writer.db.prepare('UPDATE dispatch_contexts SET depth = ? WHERE id = ?').run(3, dispatch.id)
      expect(reader.resolveCreatorDepth({ kind: 'session', orcaSessionId: sessionId })).toBe(3)
      writer.db
        .prepare('UPDATE dispatch_contexts SET creator_handle = assignee_handle WHERE id = ?')
        .run(dispatch.id)
      expect(reader.resolveCreatorDepth({ kind: 'session', orcaSessionId: sessionId })).toBe(0)
      expect(
        reader.resolveCreatorDispatchId({ kind: 'session', orcaSessionId: sessionId })
      ).toBeNull()
      expect(fullDispatchReads(compile.mock.calls)).toHaveLength(1)
    }
  )

  it.each(['fresh', 'v41'] as const)(
    'reuses gate ownership and settlement reads while preserving completed rows and blocked tasks (%s)',
    (version) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(NOW))
      const { reader, entries } = fixture(10, version)
      const compile = vi.spyOn(DatabaseSync.prototype, 'prepare')
      for (const { task, dispatch, expected } of entries) {
        const gate = reader.createGate({ taskId: task.id, question: 'Continue?' })
        expect(gate.task_id).toBe(task.id)
        expect(gate.status).toBe('pending')
        expect(reader.getDispatchContextById(dispatch.id)).toEqual({
          ...expected,
          status: 'completed',
          completed_at: NOW,
          capability_revoked_at: NOW
        })
        expect(reader.getTask(task.id)?.status).toBe('blocked')
      }
      expect(fullDispatchReads(compile.mock.calls)).toHaveLength(12)
    }
  )

  it.each(['fresh', 'v41'] as const)(
    'reuses the private failure snapshot while preserving returned committed row order (%s)',
    (version) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(NOW))
      const { reader, entries } = fixture(10, version)
      const compile = vi.spyOn(DatabaseSync.prototype, 'prepare')
      for (const { task, dispatch, expected } of entries) {
        const expectedFailure = {
          ...expected,
          status: 'failed',
          failure_count: 1,
          last_failure: 'failed send',
          completed_at: NOW,
          capability_revoked_at: NOW
        }
        const failure = reader.failDispatch(dispatch.id, 'failed send')
        expect(failure).toEqual(expectedFailure)
        expect(JSON.stringify(failure)).toBe(JSON.stringify(expectedFailure))
        expect(reader.getTask(task.id)?.status).toBe('ready')
      }
      const reads = fullDispatchReads(compile.mock.calls)
      compile.mockRestore()
      const first = entries[0]
      if (!first) {
        throw new Error('Missing failure fixture')
      }
      const before = reader.db
        .prepare('SELECT * FROM dispatch_contexts WHERE id = ?')
        .get(first.dispatch.id)
      const early = reader.failDispatch(first.dispatch.id, 'later')
      expect(JSON.stringify(early)).toBe(JSON.stringify(before))
      expect(early).not.toBe(reader.failDispatch(first.dispatch.id, 'later'))
      expect(reads).toHaveLength(21)
    }
  )

  it.each(['fresh', 'v41'] as const)(
    'reuses legacy dispatch identity scans with full rows and immediately fences settled rows (%s)',
    (version) => {
      const {
        writer,
        reader,
        run,
        entries: [{ dispatch, expected }]
      } = fixture(1, version)
      writer.db
        .prepare('UPDATE dispatch_contexts SET contract_version = ? WHERE id = ?')
        .run(LEGACY_CONTRACT_VERSION, dispatch.id)
      const compile = vi.spyOn(DatabaseSync.prototype, 'prepare')
      for (let call = 0; call < 10; call += 1) {
        expect(
          reader.resolveLegacyWorkerCandidate({ runId: run.id, terminalHandle: 'worker_0' })
        ).toEqual({ dispatch: { ...expected, contract_version: LEGACY_CONTRACT_VERSION } })
        expect(
          reader.resolveLegacyWorkerCandidate({ runId: run.id, terminalHandle: 'missing' })
        ).toBeUndefined()
      }
      writer.db
        .prepare('UPDATE dispatch_contexts SET status = ? WHERE id = ?')
        .run('completed', dispatch.id)
      expect(
        reader.resolveLegacyWorkerCandidate({ runId: run.id, terminalHandle: 'worker_0' })
      ).toBeUndefined()
      expect(fullDispatchReads(compile.mock.calls)).toHaveLength(1)
    }
  )
})
