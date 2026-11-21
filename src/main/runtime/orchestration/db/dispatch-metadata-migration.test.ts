import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address'
import { OrchestrationDb } from './orchestration-db'
import { createRootDispatch } from './root-dispatch-test-fixture'
import { LEGACY_CONTRACT_VERSION } from './contract-constants'
import { DROP_REMOVED_WORK_TRIGGERS_SQL } from './reset/removed-orchestration-work-store'

const databases: OrchestrationDb[] = []
const directories: string[] = []
const NOW = '2026-10-02T12:00:00.000Z'
const PANE = 'tab_worker:11111111-1111-4111-8111-111111111111'

afterEach(() => {
  vi.useRealTimers()
  for (const db of databases.splice(0)) {
    db.close()
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-dispatch-metadata-migration-'))
  directories.push(directory)
  const path = join(directory, 'orchestration.db')
  const original = new OrchestrationDb(path)
  databases.push(original)
  const run = original.createRun({
    objective: 'dispatch lifecycle',
    coordinatorHandle: 'coordinator',
    coordinatorPaneKey: 'tab_coordinator:22222222-2222-4222-8222-222222222222'
  })
  const task = original.createTask({ spec: 'work', runId: run.id })
  const dispatch = createRootDispatch(original, task.id, 'worker_0', PANE)
  original.db
    .prepare('UPDATE dispatch_contexts SET status = ?, dispatched_at = ?, depth = ? WHERE id = ?')
    .run('dispatched', '2026-10-02 10:00:00', 2, dispatch.id)
  original.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('dispatched', task.id)
  original.db.exec(`
      ${DROP_REMOVED_WORK_TRIGGERS_SQL}
      DROP INDEX idx_runs_coordinator_orca_session_id;
      DROP INDEX idx_dispatch_assignee_orca_session_id;
      DROP INDEX idx_dispatch_creator_orca_session_id;
      DROP INDEX idx_dispatch_assignee_orca_session_backfill;
      DROP INDEX idx_dispatch_creator_orca_session_backfill;
      DROP INDEX idx_dispatch_session_presentation;
      DROP TRIGGER trg_runs_remember_coordinator_insert;
      DROP TRIGGER trg_runs_remember_coordinator_update;
      DROP TRIGGER trg_messages_route_coordinator_mail;
      ALTER TABLE runs DROP COLUMN coordinator_orca_session_id;
      ALTER TABLE runs DROP COLUMN coordinator_orca_session_id_generation;
      ALTER TABLE dispatch_contexts DROP COLUMN assignee_orca_session_id;
      ALTER TABLE dispatch_contexts DROP COLUMN creator_orca_session_id;
    `)
  original.db.pragma('user_version = 41')
  original.close()
  databases.pop()

  const writer = new OrchestrationDb(path)
  databases.push(writer)
  const reader = new OrchestrationDb(path)
  databases.push(reader)
  return { writer, reader, run, dispatch }
}

describe('dispatch metadata after upgrading a v41 database', () => {
  it('looks up a direct owner and sees owner changes from another connection', () => {
    const { writer, reader, run, dispatch } = fixture()
    vi.useFakeTimers()
    vi.setSystemTime(new Date(NOW))
    const expected = {
      id: dispatch.id,
      assignee_handle: 'worker_0',
      status: 'dispatched',
      depth: 2
    }
    expect(reader.findActiveDispatchForDirectMessageOwner(run.id, 'worker_0')).toMatchObject(
      expected
    )
    expect(reader.findActiveDispatchForDirectMessageOwner(run.id, 'missing', PANE)).toMatchObject(
      expected
    )
    expect(
      reader.findActiveDispatchForDirectMessageOwner(
        run.id,
        'missing',
        PANE.replace('tab_worker:', 'reminted:')
      )
    ).toMatchObject(expected)
    expect(
      reader.findActiveDispatchForDirectMessageOwner(run.id, 'missing', 'bad:legacy')
    ).toBeUndefined()
    writer.db
      .prepare(
        'UPDATE dispatch_contexts SET last_heartbeat_at = ?, assignee_handle = ? WHERE id = ?'
      )
      .run(NOW, 'updated', dispatch.id)
    expect(reader.findActiveDispatchForDirectMessageOwner(run.id, 'worker_0')).toBeUndefined()
    expect(reader.findActiveDispatchForDirectMessageOwner(run.id, 'updated')).toMatchObject({
      ...expected,
      last_heartbeat_at: NOW,
      assignee_handle: 'updated'
    })
  })

  it('uses the updated creator depth and excludes self-created parents', () => {
    const { writer, reader, dispatch } = fixture()
    const sessionId = '00000000-0000-4000-8000-000000000001'
    if (!isOrcaSessionId(sessionId)) {
      throw new Error('Invalid session fixture')
    }
    writer.db
      .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
      .run(sessionId, dispatch.id)
    expect(reader.resolveCreatorDepth({ kind: 'session', orcaSessionId: sessionId })).toBe(2)
    expect(reader.resolveCreatorDispatchId({ kind: 'session', orcaSessionId: sessionId })).toBe(
      dispatch.id
    )
    writer.db.prepare('UPDATE dispatch_contexts SET depth = ? WHERE id = ?').run(3, dispatch.id)
    expect(reader.resolveCreatorDepth({ kind: 'session', orcaSessionId: sessionId })).toBe(3)
    writer.db
      .prepare('UPDATE dispatch_contexts SET creator_handle = assignee_handle WHERE id = ?')
      .run(dispatch.id)
    expect(reader.resolveCreatorDepth({ kind: 'session', orcaSessionId: sessionId })).toBe(0)
    expect(
      reader.resolveCreatorDispatchId({ kind: 'session', orcaSessionId: sessionId })
    ).toBeNull()
  })

  it('finds legacy candidates and excludes a worker once it settles', () => {
    const { writer, reader, run, dispatch } = fixture()
    writer.db
      .prepare('UPDATE dispatch_contexts SET contract_version = ? WHERE id = ?')
      .run(LEGACY_CONTRACT_VERSION, dispatch.id)
    expect(
      reader.resolveLegacyWorkerCandidate({ runId: run.id, terminalHandle: 'worker_0' })
    ).toMatchObject({ dispatch: { id: dispatch.id, contract_version: LEGACY_CONTRACT_VERSION } })
    expect(
      reader.resolveLegacyWorkerCandidate({ runId: run.id, terminalHandle: 'missing' })
    ).toBeUndefined()
    writer.db
      .prepare('UPDATE dispatch_contexts SET status = ? WHERE id = ?')
      .run('completed', dispatch.id)
    expect(
      reader.resolveLegacyWorkerCandidate({ runId: run.id, terminalHandle: 'worker_0' })
    ).toBeUndefined()
  })
})
