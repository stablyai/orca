import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'

describe('guarded lifecycle transitions', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('rejects a stale prior state without changing the projection', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'guarded transition' })

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
    const task = db.createTask({ spec: 'caller-owned rollback' })

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

  it.each([
    ['ready', 'pending'],
    ['blocked', 'completed'],
    ['failed', 'completed'],
    ['completed', 'blocked']
  ] as const)('preserves public task updates from %s to %s', (from, to) => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'manual status correction' })
    db.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(from, task.id)

    expect(db.updateTaskStatus(task.id, to)?.status).toBe(to)
  })
})
