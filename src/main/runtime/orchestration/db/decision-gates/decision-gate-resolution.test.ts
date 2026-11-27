import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

const runId = 'run_legacy_local'
let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

describe('decision gate resolution', () => {
  it('keeps the first answer, replays it, and refuses a different one', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId, spec: 'needs one decision' })
    const gate = db.createGate({ taskId: task.id, question: 'Proceed?' })

    expect(db.resolveGate(gate.id, 'yes')).toMatchObject({ status: 'resolved', resolution: 'yes' })
    expect(db.resolveGate(gate.id, 'yes')).toMatchObject({ status: 'resolved', resolution: 'yes' })
    expect(() => db?.resolveGate(gate.id, 'no')).toThrowError(
      expect.objectContaining({ code: 'answer_conflict' })
    )
    expect(db.getGate(gate.id)).toMatchObject({ status: 'resolved', resolution: 'yes' })
    expect(db.getTask(task.id)?.status).toBe('ready')
  })

  it('leaves a task that moved past ready alone when the answer is replayed', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId, spec: 'moved on' })
    const gate = db.createGate({ taskId: task.id, question: 'Proceed?' })
    db.resolveGate(gate.id, 'yes')
    db.updateTaskStatus(task.id, 'failed')

    expect(db.resolveGate(gate.id, 'yes')).toMatchObject({ status: 'resolved', resolution: 'yes' })
    expect(db.getTask(task.id)?.status).toBe('failed')
  })
})
