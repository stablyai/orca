import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('OrchestrationDb.updateTaskDeps', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('updates deps in place and re-evaluates pending/ready', () => {
    const d = createDb()
    const t1 = d.createTask({ spec: 'a' })
    const t2 = d.createTask({ spec: 'b' })
    const child = d.createTask({ spec: 'c', deps: [t1.id] })
    expect(child.status).toBe('pending')

    const cleared = d.updateTaskDeps(child.id, [])
    expect(cleared?.status).toBe('ready')
    expect(JSON.parse(cleared!.deps)).toEqual([])

    const reblocked = d.updateTaskDeps(child.id, [t2.id])
    expect(reblocked?.status).toBe('pending')
    expect(JSON.parse(reblocked!.deps)).toEqual([t2.id])

    d.updateTaskStatus(t2.id, 'completed')
    const withCompletedDep = d.updateTaskDeps(child.id, [t2.id])
    expect(withCompletedDep?.status).toBe('ready')
  })

  it('refuses deps updates after dispatch', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'work' })
    d.updateTaskStatus(task.id, 'dispatched')
    expect(() => d.updateTaskDeps(task.id, [])).toThrow(/only pending or ready/)
  })

  it('rejects a dependency that already reaches the updated task', () => {
    const d = createDb()
    const first = d.createTask({ spec: 'first' })
    const second = d.createTask({ spec: 'second', deps: [first.id] })

    expect(() => d.updateTaskDeps(first.id, [second.id])).toThrow(/dependency cycle/i)
    expect(d.getTask(first.id)).toMatchObject({ status: 'ready', deps: '[]' })
    expect(d.getTask(second.id)).toMatchObject({
      status: 'pending',
      deps: JSON.stringify([first.id])
    })
  })
})
