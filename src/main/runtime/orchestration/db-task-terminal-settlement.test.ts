import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

function sqliteFor(db: OrchestrationDb): Database.Database {
  return (db as unknown as { db: Database.Database }).db
}

describe('task terminal settlement', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it.each(['completed', 'failed'] as const)(
    'rolls back a %s task when dispatch settlement fails',
    (status) => {
      const currentDb = (db = new OrchestrationDb(':memory:'))
      const task = currentDb.createTask({ spec: 'work' })
      const dependent = currentDb.createTask({ spec: 'next', deps: [task.id] })
      const dispatch = currentDb.createDispatchContext(task.id, 'term_worker')
      sqliteFor(currentDb).exec(`
        CREATE TRIGGER reject_dispatch_settlement
        BEFORE UPDATE OF status ON dispatch_contexts
        BEGIN
          SELECT RAISE(ABORT, 'forced dispatch settlement failure');
        END;
      `)

      expect(() => currentDb.updateTaskStatus(task.id, status, 'manual terminal update')).toThrow(
        'forced dispatch settlement failure'
      )
      expect(currentDb.getTask(task.id)).toMatchObject({
        status: 'dispatched',
        result: null,
        completed_at: null
      })
      expect(currentDb.getDispatchContextById(dispatch.id)).toMatchObject({
        status: 'dispatched',
        completed_at: null,
        capability_revoked_at: null
      })
      expect(currentDb.getTask(dependent.id)?.status).toBe('pending')
    }
  )

  it('does not commit a caller-owned transaction', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker')
    const sqlite = sqliteFor(db)

    sqlite.exec('BEGIN IMMEDIATE')
    db.updateTaskStatus(task.id, 'failed')
    sqlite.exec('ROLLBACK')

    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  it.each(['completed', 'failed'] as const)(
    'rejects a %s task update while its worker is still active',
    (status) => {
      const currentDb = (db = new OrchestrationDb(':memory:'))
      const task = currentDb.createTask({ spec: 'supervised work' })
      const started = currentDb.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
      const capability = currentDb.prepareStartingWorkerAuthority({
        dispatchId: started.dispatch.id,
        handle: 'term_worker',
        paneKey: 'tab_worker:leaf_worker',
        processIncarnation: 'worker:1',
        worktreeId: 'repo::worker',
        setupState: 'not_applicable',
        effects: [],
        terminalOwnership: 'created'
      })
      currentDb.markWorkerDispatchReady(started.dispatch.id)

      expect(() => currentDb.updateTaskStatus(task.id, status, 'must not persist')).toThrowError(
        expect.objectContaining({
          code: 'task_not_startable',
          data: { taskId: task.id, dispatchId: started.dispatch.id }
        })
      )
      expect(currentDb.getTask(task.id)).toMatchObject({
        status: 'dispatched',
        result: null,
        completed_at: null
      })
      expect(currentDb.getDispatchContextById(started.dispatch.id)).toMatchObject({
        status: 'dispatched',
        completed_at: null,
        capability_revoked_at: null
      })
      expect(currentDb.getWorkerDispatch(started.dispatch.id)?.state).toBe('ready')
      expect(currentDb.getWorkerTerminalResourceByOwner(started.dispatch.id)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'not_requested'
      })
      expect(
        currentDb.verifyDispatchCapability({
          dispatchId: started.dispatch.id,
          capability,
          paneKey: 'tab_worker:leaf_worker',
          processIncarnation: 'worker:1'
        })
      ).toEqual({ valid: true })
    }
  )
})
