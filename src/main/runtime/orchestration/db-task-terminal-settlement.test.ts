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
      db = new OrchestrationDb(':memory:')
      const task = db.createTask({ spec: 'work' })
      const dependent = db.createTask({ spec: 'next', deps: [task.id] })
      const dispatch = db.createDispatchContext(task.id, 'term_worker')
      sqliteFor(db).exec(`
        CREATE TRIGGER reject_dispatch_settlement
        BEFORE UPDATE OF status ON dispatch_contexts
        BEGIN
          SELECT RAISE(ABORT, 'forced dispatch settlement failure');
        END;
      `)

      expect(() => db.updateTaskStatus(task.id, status, 'manual terminal update')).toThrow(
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
})
