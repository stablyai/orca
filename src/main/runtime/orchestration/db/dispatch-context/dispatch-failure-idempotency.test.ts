import { describe, expect, it } from 'vitest'
import type Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import '../messages/mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'
import { createRootDispatch } from '../root-dispatch-test-fixture'

describe('dispatch failure idempotency', () => {
  it('rolls back the dispatch when the task update fails', () => {
    const db = new OrchestrationDb(':memory:')
    const sqlite = (db as unknown as { db: Database.Database }).db
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker')
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
