import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

type DatabaseHarness = {
  db: OrchestrationDb
  dir: string
  path: string
}

const harnesses: DatabaseHarness[] = []

afterEach(() => {
  vi.restoreAllMocks()
  const closed = harnesses.splice(0)
  for (const harness of closed) {
    harness.db.close()
  }
  for (const dir of new Set(closed.map((harness) => harness.dir))) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Task/Dispatch invariant transactions', () => {
  it.each(['completed', 'failed'] as const)(
    'rolls back a %s Task when Dispatch settlement fails',
    (status) => {
      const { db } = createDatabase()
      const task = db.createTask({ spec: 'atomic work' })
      const dependent = db.createTask({ spec: 'dependent work', deps: [task.id] })
      const dispatch = createRootDispatch(db, task.id, 'term_worker')
      const capability = db.mintDispatchCapability({
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
      expect(
        db.verifyDispatchCapability({
          dispatchId: dispatch.id,
          capability,
          paneKey: 'tab_worker:leaf_worker',
          processIncarnation: 'worker:1'
        })
      ).toEqual({ valid: true })
      expect(db.getTask(dependent.id)?.status).toBe('pending')
    }
  )

  it('does not commit a caller-owned transaction', () => {
    const { db } = createDatabase()
    const task = db.createTask({ spec: 'outer transaction work' })
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
    const task = db.createTask({ spec: 'outer transaction dispatch' })
    const sqlite = sqliteFor(db)

    sqlite.exec('BEGIN IMMEDIATE')
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    sqlite.exec('ROLLBACK')

    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(db.getDispatchContextById(dispatch.id)).toBeUndefined()
  })

  it.each(['completed', 'failed'] as const)(
    'settles every active Dispatch left by a pre-fix split when the Task becomes %s',
    (status) => {
      const { db } = createDatabase()
      const task = db.createTask({ spec: 'legacy split work' })
      const first = createRootDispatch(db, task.id, 'term_first')
      sqliteFor(db).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
      const second = createRootDispatch(db, task.id, 'term_second')

      db.updateTaskStatus(task.id, status, 'terminal result')

      for (const dispatch of [first, second]) {
        expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
          status,
          completed_at: expect.any(String),
          capability_revoked_at: expect.any(String)
        })
      }
      expect(db.getActiveDispatchForTerminal('term_first')).toBeUndefined()
      expect(db.getActiveDispatchForTerminal('term_second')).toBeUndefined()
      expect(() =>
        createRootDispatch(db, db.createTask({ spec: 'first later work' }).id, 'term_first')
      ).not.toThrow()
      expect(() =>
        createRootDispatch(db, db.createTask({ spec: 'second later work' }).id, 'term_second')
      ).not.toThrow()
    }
  )

  it('does not requeue a legacy split Task while another Dispatch remains active', () => {
    const { db } = createDatabase()
    const task = db.createTask({ spec: 'legacy split retry' })
    const first = createRootDispatch(db, task.id, 'term_first')
    sqliteFor(db).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const second = createRootDispatch(db, task.id, 'term_second')

    db.failDispatch(second.id, 'targeted failure')

    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(first.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(second.id)?.status).toBe('failed')
  })

  it('does not block a legacy split Task while another Dispatch remains active', () => {
    const { db } = createDatabase()
    const task = db.createTask({ spec: 'legacy split release' })
    const first = createRootDispatch(db, task.id, 'term_first')
    sqliteFor(db).prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(task.id)
    const second = createRootDispatch(db, task.id, 'term_second')

    expect(db.beginWorkerStop(second.id, 'runtime_test')).toMatchObject({
      disposition: 'context_only',
      releasedCurrentTask: false
    })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(first.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(second.id)?.status).toBe('failed')
  })

  it.each(['pending', 'ready', 'blocked'] as const)(
    'rejects moving a Task to %s while a Dispatch remains active',
    (status) => {
      const { db } = createDatabase()
      const task = db.createTask({ spec: 'guarded work' })
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
    const task = db.createTask({ spec: 'unassigned work' })

    expect(() => db.updateTaskStatus(task.id, 'dispatched')).toThrowError(
      expect.objectContaining({
        code: 'task_not_startable',
        data: { taskId: task.id }
      })
    )
    expect(db.getTask(task.id)?.status).toBe('ready')
  })

  it('rejects a Dispatch when failure wins after readiness was observed', () => {
    const first = createDatabase()
    const concurrent = createDatabase(first.path)
    const task = first.db.createTask({ spec: 'interleaved work' })
    const sqlite = sqliteFor(first.db)
    const prepare = sqlite.prepare.bind(sqlite)
    let injected = false
    vi.spyOn(sqlite, 'prepare').mockImplementation((sql) => {
      if (!injected && sql.includes('INSERT INTO dispatch_contexts')) {
        injected = true
        concurrent.db.updateTaskStatus(task.id, 'failed', 'failure won')
      }
      return prepare(sql)
    })

    expect(() => createRootDispatch(first.db, task.id, 'term_worker')).toThrow(
      `Task ${task.id} is failed; only ready tasks can be dispatched`
    )
    expect(injected).toBe(true)
    expect(first.db.getTask(task.id)).toMatchObject({ status: 'failed', result: 'failure won' })
    expect(first.db.getDispatchContext(task.id)).toBeUndefined()
  })

  it('atomically rejects a same-pane Dispatch that loses the occupancy race', () => {
    const first = createDatabase()
    const concurrent = createDatabase(first.path)
    const firstTask = first.db.createTask({ spec: 'first terminal claimant' })
    const secondTask = first.db.createTask({ spec: 'second terminal claimant' })
    const sqlite = sqliteFor(first.db)
    const prepare = sqlite.prepare.bind(sqlite)
    let winnerId: string | undefined
    vi.spyOn(sqlite, 'prepare').mockImplementation((sql) => {
      if (!winnerId && sql.includes('INSERT INTO dispatch_contexts')) {
        winnerId = createRootDispatch(
          concurrent.db,
          secondTask.id,
          'term_reminted',
          'tab_new:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
        ).id
      }
      return prepare(sql)
    })

    expect(() =>
      createRootDispatch(
        first.db,
        firstTask.id,
        'term_worker',
        'tab_old:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
      )
    ).toThrow(/already has an active dispatch/)
    expect(winnerId).toBeDefined()
    expect(first.db.getTask(firstTask.id)?.status).toBe('ready')
    expect(first.db.getTask(secondTask.id)?.status).toBe('dispatched')
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM dispatch_contexts WHERE status IN ('pending', 'dispatched')"
        )
        .get()
    ).toEqual({ count: 1 })
  })

  it('rejects worker authority when another Dispatch owns the pane', () => {
    const { db } = createDatabase()
    const ownerTask = db.createTask({ spec: 'current pane owner' })
    const owner = createRootDispatch(
      db,
      ownerTask.id,
      'term_owner',
      'tab_old:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    )
    const workerTask = db.createTask({ spec: 'competing supervised worker' })
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
      const task = db.createTask({ spec: 'supervised lifecycle' })
      const started = db.createStartingWorkerDispatch({
        creator: { kind: 'system' },
        maxDepth: Number.MAX_SAFE_INTEGER,
        taskId: task.id,
        startOptions: {}
      })
      const capability = db.prepareStartingWorkerAuthority({
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
      expect(
        db.verifyDispatchCapability({
          dispatchId: started.dispatch.id,
          capability,
          paneKey: 'tab_worker:dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          processIncarnation: 'worker:1'
        })
      ).toEqual({ valid: true })
    }
  )

  it('keeps a federated late start authoritative after rejecting Task failure', () => {
    const { db } = createDatabase()
    const task = db.createTask({ spec: 'federated lifecycle' })
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
