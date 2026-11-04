import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import {
  rollbackLifecycleWriteTransaction,
  type LifecycleWriteTransaction
} from './lifecycle-transition'
import { runLifecycleWriteTransaction } from './lifecycle-write-transaction-runner'

describe('guarded lifecycle transitions', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('rejects a stale prior state without changing the projection', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'guarded transition' })

    expect(() =>
      db!.transitionLifecycle({
        entity: 'task',
        id: task.id,
        from: 'pending',
        to: 'completed'
      })
    ).toThrow(/expected pending/)
    expect(db.getTask(task.id)?.status).toBe('ready')
  })

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

describe('lifecycle write rollback guards', () => {
  it('skips a rollback after the failed statement already ended the transaction (#38123)', () => {
    // SQLite aborts the transaction on disk/IO errors; a later ROLLBACK would throw
    // "cannot rollback - no transaction is active" and hide the real failure.
    const exec = vi.fn()
    const db = { isTransaction: false, exec } as never
    const transaction: LifecycleWriteTransaction = { savepoint: null }

    expect(() => rollbackLifecycleWriteTransaction(db, transaction)).not.toThrow()
    expect(exec).not.toHaveBeenCalled()
  })

  it('rolls back a savepoint only while its transaction stands', () => {
    const exec = vi.fn()
    const db = { isTransaction: true, exec } as never

    rollbackLifecycleWriteTransaction(db, { savepoint: 'worker_report_transaction' })

    expect(exec.mock.calls).toEqual([
      ['ROLLBACK TO worker_report_transaction'],
      ['RELEASE worker_report_transaction']
    ])
  })

  it('reports the operation failure even when the rollback itself throws', () => {
    const db = {
      isTransaction: true,
      exec: (sql: string) => {
        if (sql === 'BEGIN IMMEDIATE' || sql.startsWith('SAVEPOINT')) {
          return
        }
        throw new Error('cannot rollback - no transaction is active')
      }
    } as never

    expect(() =>
      runLifecycleWriteTransaction(db, 'worker_report_transaction', () => {
        throw new Error('disk I/O error')
      })
    ).toThrow('disk I/O error')
  })
})
