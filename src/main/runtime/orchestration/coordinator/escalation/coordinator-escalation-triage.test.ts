import { afterEach, describe, expect, it } from 'vitest'
import { applyEscalationToDispatch } from './coordinator-escalation-triage'
import { OrchestrationDb } from '../../db/orchestration-db'
import '../../db/contract-constants'
import '../../db/messages/mailbox-routing-page'
import '../../db/dispatch-row-writer'
import '../../db/attempt-outcome-projection'
import { createRootDispatch } from '../../db/root-dispatch-test-fixture'

describe('coordinator escalation authority', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('accepts the canonical sender of an imported federated Dispatch', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'remote escalation target' })
    const dispatch = createRootDispatch(db, task.id, 'remote-worker')

    applyEscalationToDispatch(
      db,
      db.insertMessage({
        runId: 'run_legacy_local',
        from: `dispatch:${dispatch.id}`,
        to: 'term_coordinator',
        subject: 'Remote worker failed',
        type: 'escalation',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id })
      }),
      () => {}
    )

    expect(db.getTask(task.id)?.status).toBe('ready')
    expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'failed',
      failure_count: 1
    })
  })
})
