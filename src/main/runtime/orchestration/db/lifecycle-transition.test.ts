import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import { runLifecycleWriteTransaction } from './lifecycle-write-transaction-runner'

describe('guarded lifecycle transitions', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('composes its projection into the caller-owned transaction', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'caller-owned rollback' })

    db.db.exec('SAVEPOINT lifecycle_test')
    expect(
      db.transitionLifecycle({
        entity: 'task',
        id: task.id,
        from: 'ready',
        to: 'completed',
        projection: { result: 'uncommitted' }
      })
    ).toEqual({ changed: true })
    expect(db.getTask(task.id)?.status).toBe('completed')
    db.db.exec('ROLLBACK TO lifecycle_test')
    db.db.exec('RELEASE lifecycle_test')

    expect(db.getTask(task.id)).toMatchObject({ status: 'ready', result: null })
  })

  it('reports the failure when SQLite already ended the transaction (#38123)', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'aborted transaction' })
    // Stands in for the disk-full and I/O errors that make SQLite roll back the whole transaction.
    db.db.exec(`CREATE TEMP TRIGGER abort_task_update BEFORE UPDATE ON tasks
      BEGIN SELECT RAISE(ROLLBACK, 'database or disk is full'); END`)

    expect(() =>
      runLifecycleWriteTransaction(db!.db, 'aborted_test', () =>
        db!.transitionLifecycle({ entity: 'task', id: task.id, from: 'ready', to: 'completed' })
      )
    ).toThrow('database or disk is full')
    expect(db.db.isTransaction).toBe(false)
    expect(db.getTask(task.id)?.status).toBe('ready')
  })
})
