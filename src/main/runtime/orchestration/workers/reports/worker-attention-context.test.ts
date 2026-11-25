import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { buildWorkerAttentionContext } from './worker-attention-context'

let db: OrchestrationDb
beforeEach(() => {
  db = new OrchestrationDb(':memory:')
})
afterEach(() => {
  db.close()
})

function startedWorker(): string {
  const task = db.createTask({ runId: 'run_legacy_local', spec: 'Verify journal writes' })
  const { dispatch } = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: 10,
    taskId: task.id,
    startOptions: { agent: 'codex' }
  })
  return dispatch.id
}

function attention(dispatchId: string) {
  const dispatch = db.getDispatchContextById(dispatchId)!
  return buildWorkerAttentionContext({
    db,
    dispatch,
    task: db.getTask(dispatch.task_id),
    evidence: undefined
  }).categories
}

describe('worker attention outcome', () => {
  it('reads a stop as stopped, though the stop still stores the Dispatch as failed', () => {
    const dispatchId = startedWorker()
    db.db
      .prepare("UPDATE worker_dispatches SET state = 'ready' WHERE dispatch_id = ?")
      .run(dispatchId)
    db.beginWorkerStop(dispatchId, 'epoch_1')
    db.settleWorkerStop(dispatchId)

    // The row shape every earlier stop already wrote, so old rows read the same way.
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      last_failure: 'stopped'
    })
    expect(attention(dispatchId)).not.toContain('failure')
  })

  it('still reads a failed start as a failure', () => {
    const dispatchId = startedWorker()
    db.failWorkerStart(dispatchId, 'verification', 'Verification exited with code 1.')

    expect(attention(dispatchId)).toContain('failure')
  })
})
