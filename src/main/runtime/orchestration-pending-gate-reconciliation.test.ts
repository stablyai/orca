import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './orchestration/db'
import { OrcaRuntimeService } from './orca-runtime'

describe('pending decision gate startup reconciliation', () => {
  it('restores blocked task state when a persisted database is attached', () => {
    const db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'approval' })
    db.createGate({ taskId: task.id, question: 'Proceed?' })
    db.updateTaskStatus(task.id, 'ready')

    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)

    expect(db.getTask(task.id)?.status).toBe('blocked')
    expect(db.listGates({ status: 'pending' })).toHaveLength(1)
    db.close()
  })
})
