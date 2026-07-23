import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('decision gate invariants', () => {
  let db: OrchestrationDb | null = null
  afterEach(() => db?.close())

  it('rejects unknown and terminal tasks without persisting a gate', () => {
    db = new OrchestrationDb(':memory:')
    expect(() => db!.createGate({ taskId: 'task_missing', question: 'ok?' })).toThrow(
      'Task not found: task_missing'
    )

    for (const status of ['completed', 'failed'] as const) {
      const task = db.createTask({ spec: status })
      db.updateTaskStatus(task.id, status)
      expect(() => db!.createGate({ taskId: task.id, question: 'ok?' })).toThrow(
        `Cannot create gate for ${status} task: ${task.id}`
      )
      expect(db.listGates({ taskId: task.id })).toEqual([])
      expect(db.getTask(task.id)?.status).toBe(status)
    }
  })

  it('does not overwrite or revive after a gate is resolved', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const gate = db.createGate({ taskId: task.id, question: 'ok?' })

    expect(db.resolveGate(gate.id, 'first')?.resolution).toBe('first')
    db.updateTaskStatus(task.id, 'completed')
    expect(db.resolveGate(gate.id, 'stale')).toBeUndefined()
    expect(db.getGate(gate.id)?.resolution).toBe('first')
    expect(db.getTask(task.id)?.status).toBe('completed')
  })

  it('keeps a task blocked while another gate remains pending', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const first = db.createGate({ taskId: task.id, question: 'first?' })
    db.createGate({ taskId: task.id, question: 'second?' })

    expect(db.resolveGate(first.id, 'yes')?.status).toBe('resolved')
    expect(db.getTask(task.id)?.status).toBe('blocked')
  })
})
