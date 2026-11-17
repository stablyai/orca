import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import { createRootDispatch, reattachDispatchConsumer } from '../root-dispatch-test-fixture'

type DatabaseHarness = {
  db: OrchestrationDb
  dir: string
  path: string
}

const harnesses: DatabaseHarness[] = []

afterEach(() => {
  const closed = harnesses.splice(0)
  for (const harness of closed) {
    harness.db.close()
  }
  for (const dir of new Set(closed.map((harness) => harness.dir))) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Task/Dispatch invariant transactions', () => {
  it.each(['failed', 'completed', 'blocked'] as const)(
    'allows a dependency-blocked pending Task to become %s',
    (status) => {
      const { db } = createDatabase()
      const dependency = db.createTask({ runId: 'run_legacy_local', spec: 'unresolved dependency' })
      const task = db.createTask({
        runId: 'run_legacy_local',
        spec: 'manual resolution',
        deps: [dependency.id]
      })
      const dependent = db.createTask({
        runId: 'run_legacy_local',
        spec: 'downstream work',
        deps: [task.id]
      })

      expect(task.status).toBe('pending')
      const updated = db.updateTaskStatus(task.id, status, 'manual resolution')

      expect(updated?.status).toBe(status)
      expect(db.getTask(task.id)?.status).toBe(status)
      expect(db.getTask(dependent.id)?.status).toBe(status === 'completed' ? 'ready' : 'pending')
    }
  )

  it.each(['completed', 'failed'] as const)(
    'rolls back a %s Task when Dispatch settlement fails',
    (status) => {
      const { db } = createDatabase()
      const task = db.createTask({ runId: 'run_legacy_local', spec: 'atomic work' })
      const dependent = db.createTask({
        runId: 'run_legacy_local',
        spec: 'dependent work',
        deps: [task.id]
      })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')
      reattachDispatchConsumer(db, {
        dispatchId: dispatch.id,
        paneKey: 'tab_worker:leaf_worker',
        processIncarnation: 'worker:1'
      })
      sqliteFor(db).exec(`
        CREATE TRIGGER reject_dispatch_settlement
        BEFORE UPDATE OF status ON dispatch_contexts
        WHEN OLD.id = '${dispatch.id}'
        BEGIN
          SELECT RAISE(ABORT, 'forced dispatch settlement failure');
        END;
      `)

      expect(() => db.updateTaskStatus(task.id, status, 'must roll back')).toThrow(
        'forced dispatch settlement failure'
      )
      expect(db.getTask(task.id)).toMatchObject({
        status: 'dispatched',
        result: null,
        completed_at: null
      })
      expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
        status: 'dispatched',
        completed_at: null,
        capability_revoked_at: null
      })
      expect(db.getTask(dependent.id)?.status).toBe('pending')
    }
  )

  it('does not commit a caller-owned transaction', () => {
    const { db } = createDatabase()
    const task = db.createTask({
      runId: 'run_legacy_local',
      spec: 'outer transaction work'
    })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    const sqlite = sqliteFor(db)

    sqlite.exec('BEGIN IMMEDIATE')
    db.updateTaskStatus(task.id, 'failed', 'inside outer transaction')
    expect(db.getTask(task.id)?.status).toBe('failed')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('failed')
    sqlite.exec('ROLLBACK')

    expect(db.getTask(task.id)).toMatchObject({
      status: 'dispatched',
      result: null,
      completed_at: null
    })
    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'dispatched',
      completed_at: null,
      capability_revoked_at: null
    })
  })

  it('keeps Dispatch creation inside a caller-owned transaction', () => {
    const { db } = createDatabase()
    const task = db.createTask({
      runId: 'run_legacy_local',
      spec: 'outer transaction dispatch'
    })
    const sqlite = sqliteFor(db)

    sqlite.exec('BEGIN IMMEDIATE')
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    sqlite.exec('ROLLBACK')

    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(db.getDispatchContextById(dispatch.id)).toBeUndefined()
  })

  it.each(['pending', 'ready', 'blocked'] as const)(
    'rejects moving a Task to %s while a Dispatch remains active',
    (status) => {
      const { db } = createDatabase()
      const task = db.createTask({
        runId: 'run_legacy_local',
        spec: 'guarded work'
      })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')

      expect(() => db.updateTaskStatus(task.id, status, 'must not persist')).toThrowError(
        expect.objectContaining({
          code: 'task_not_startable',
          data: { taskId: task.id, dispatchId: dispatch.id }
        })
      )
      expect(db.getTask(task.id)).toMatchObject({ status: 'dispatched', result: null })
      expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    }
  )

  it('rejects moving a Task to dispatched without an active Dispatch', () => {
    const { db } = createDatabase()
    const task = db.createTask({
      runId: 'run_legacy_local',
      spec: 'unassigned work'
    })

    expect(() => db.updateTaskStatus(task.id, 'dispatched')).toThrowError(
      expect.objectContaining({
        code: 'task_not_startable',
        data: { taskId: task.id }
      })
    )
    expect(db.getTask(task.id)?.status).toBe('ready')
  })

  it('rejects worker authority when another Dispatch owns the pane', () => {
    const { db } = createDatabase()
    const ownerTask = db.createTask({
      runId: 'run_legacy_local',
      spec: 'current pane owner'
    })
    const owner = createRootDispatch(
      db,
      ownerTask.id,
      'term_owner',
      'tab_old:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    )
    const workerTask = db.createTask({
      runId: 'run_legacy_local',
      spec: 'competing supervised worker'
    })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: workerTask.id,
      startOptions: {}
    })

    expect(() =>
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_reminted',
        paneKey: 'tab_new:cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        processIncarnation: 'worker:1',
        worktreeId: 'repo::worker',
        effects: [],
        setupState: 'not_applicable',
        terminalOwnership: 'external'
      })
    ).toThrow(`already has an active dispatch (${owner.id} for task ${ownerTask.id})`)
    expect(db.getDispatchContextById(started.dispatch.id)).toMatchObject({
      status: 'pending',
      assignee_handle: null,
      capability_hash: null
    })
    expect(db.getWorkerDispatch(started.dispatch.id)).toMatchObject({
      state: 'starting',
      stage: 'accepted',
      agent_terminal_handle: null
    })
  })

  it.each(['completed', 'failed'] as const)(
    'rejects a %s Task update while its supervised worker remains active',
    (status) => {
      const { db } = createDatabase()
      const task = db.createTask({
        runId: 'run_legacy_local',
        spec: 'supervised lifecycle'
      })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: {}
      })
      db.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_worker',
        paneKey: 'tab_worker:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        processIncarnation: 'worker:1',
        worktreeId: 'repo::worker',
        effects: [],
        setupState: 'not_applicable',
        terminalOwnership: 'created'
      })

      expect(() => db.updateTaskStatus(task.id, status, 'must not persist')).toThrowError(
        expect.objectContaining({
          code: 'task_not_startable',
          data: { taskId: task.id, dispatchId: started.dispatch.id }
        })
      )
      expect(db.getTask(task.id)).toMatchObject({
        status: 'dispatched',
        result: null,
        completed_at: null
      })
      expect(db.getDispatchContextById(started.dispatch.id)).toMatchObject({
        status: 'pending',
        completed_at: null,
        capability_revoked_at: null
      })
      expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('starting')
    }
  )

  it('keeps a federated late start authoritative after rejecting Task failure', () => {
    const { db } = createDatabase()
    const task = db.createTask({
      runId: 'run_legacy_local',
      spec: 'federated lifecycle'
    })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {},
      federation: {
        environmentId: 'server-1',
        environmentName: 'worker server',
        peerFingerprint: 'peer-1',
        protocolVersion: 3
      }
    })

    expect(() =>
      db.updateTaskStatus(task.id, 'failed', 'must not outrun remote start')
    ).toThrowError(
      expect.objectContaining({
        code: 'task_not_startable',
        data: { taskId: task.id, dispatchId: started.dispatch.id }
      })
    )
    expect(() => db.markWorkerDispatchReady(started.dispatch.id)).not.toThrow()
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
    expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('ready')
  })
})

function createDatabase(path?: string): DatabaseHarness {
  const dir = path ? harnesses.find((harness) => harness.path === path)?.dir : undefined
  const ownedDir = dir ?? mkdtempSync(join(tmpdir(), 'orca-task-dispatch-db-'))
  const dbPath = path ?? join(ownedDir, 'orchestration.db')
  const harness = { db: new OrchestrationDb(dbPath), dir: ownedDir, path: dbPath }
  harnesses.push(harness)
  return harness
}

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}
