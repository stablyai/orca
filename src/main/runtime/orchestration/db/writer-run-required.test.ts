import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './orchestration-db'

describe('writers require a Run', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  it('rejects a message without a Run instead of using the legacy Run', () => {
    expect(() => db.insertMessage({ from: 'sender', to: 'worker', subject: 'mail' })).toThrow(
      'Run is required'
    )
    expect(db.db.prepare('SELECT id FROM messages').all()).toEqual([])
  })

  it('rejects a Task without a Run instead of using the legacy Run', () => {
    expect(() => db.createTask({ spec: 'work' })).toThrow('Run is required')
    expect(db.listTasks()).toEqual([])
  })

  it('rejects a decision gate whose Task has no Run', () => {
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'work' })
    vi.spyOn(db, 'getTask').mockReturnValue({ ...task, run_id: undefined } as never)
    expect(() => db.createGate({ taskId: task.id, question: 'Proceed?' })).toThrow()
    expect(db.listGates()).toEqual([])
  })

  it('rejects a decision gate without a Task before writing', () => {
    db.db.exec(`
      CREATE TRIGGER reject_gate_insert BEFORE INSERT ON decision_gates
      BEGIN SELECT RAISE(ABORT, 'gate insert reached'); END;
    `)
    expect(() => db.createGate({ taskId: 'missing', question: 'Proceed?' })).toThrow(
      'Task missing was not found while creating a decision gate.'
    )
    expect(db.listGates()).toEqual([])
  })
})
