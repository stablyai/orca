import { describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

describe('dispatch failure idempotency', () => {
  it('counts an active dispatch failure only once', () => {
    const db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker')

    expect(db.failDispatch(dispatch.id, 'exit')?.failure_count).toBe(1)
    const duplicate = db.failDispatch(dispatch.id, 'duplicate escalation')

    expect(duplicate?.failure_count).toBe(1)
    expect(duplicate?.status).toBe('failed')
    db.close()
  })

  it('does not overwrite a completed dispatch', () => {
    const db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker')
    db.completeDispatch(dispatch.id)

    const lateFailure = db.failDispatch(dispatch.id, 'late exit')

    expect(lateFailure?.failure_count).toBe(0)
    expect(lateFailure?.status).toBe('completed')
    db.close()
  })

  it('rolls back the dispatch when the task update fails', () => {
    const db = new OrchestrationDb(':memory:')
    const sqlite = (db as unknown as { db: Database.Database }).db
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker')
    sqlite.exec(`
      CREATE TRIGGER reject_task_failure_update
      BEFORE UPDATE ON tasks WHEN OLD.id = '${task.id}'
      BEGIN
        SELECT RAISE(ABORT, 'blocked');
      END;
    `)

    expect(() => db.failDispatch(dispatch.id, 'exit')).toThrow('blocked')
    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
      failure_count: 0,
      status: 'dispatched'
    })
    expect(db.getTask(task.id)?.status).toBe('dispatched')

    sqlite.exec('DROP TRIGGER reject_task_failure_update')
    expect(db.failDispatch(dispatch.id, 'retry')).toMatchObject({
      failure_count: 1,
      status: 'failed'
    })
    expect(db.getTask(task.id)?.status).toBe('ready')
    db.close()
  })
})
