import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration-db'
import { createRootDispatch } from './root-dispatch-test-fixture'

describe('decision-gate lifecycle transitions', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('blocks the dispatched Task when creating a gate', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'gate blocks task' })
    createRootDispatch(db, task.id, 'term_gate')
    expect(db.getTask(task.id)?.status).toBe('dispatched')

    db.createGate({ taskId: task.id, question: 'Proceed?' })

    expect(db.getTask(task.id)?.status).toBe('blocked')
  })

  it('rolls back the gate row when the Task transition cannot commit', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'atomic gate creation' })
    const dispatch = createRootDispatch(db, task.id, 'term_gate')
    db.db.exec(`
      CREATE TRIGGER reject_gate_task_block
      BEFORE UPDATE ON tasks
      WHEN NEW.status = 'blocked'
      BEGIN SELECT RAISE(ABORT, 'forced gate task block failure'); END;
    `)

    expect(() => db!.createGate({ taskId: task.id, question: 'Proceed?' })).toThrow(
      'forced gate task block failure'
    )
    expect(db.listGates({ taskId: task.id })).toHaveLength(0)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })
})
