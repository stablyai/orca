import { afterEach, describe, expect, it } from 'vitest'
import { applyEscalationToDispatch } from './coordinator-escalation-triage'
import { OrchestrationDb } from './db'

describe('coordinator escalation authority', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('rejects an escalation targeting another active Dispatch', () => {
    db = new OrchestrationDb(':memory:')
    const attackerTask = db.createTask({ spec: 'attacker assignment' })
    const attacker = db.createDispatchContext(
      attackerTask.id,
      'term_attacker',
      'tab_attacker:leaf_attacker'
    )
    const victimTask = db.createTask({ spec: 'victim assignment' })
    const victim = db.createDispatchContext(victimTask.id, 'term_victim')
    const logs: string[] = []

    applyEscalationToDispatch(
      db,
      db.insertMessage({
        from: 'term_attacker',
        to: 'term_coordinator',
        subject: 'Fail the victim',
        type: 'escalation',
        senderPaneKey: 'tab_attacker:leaf_attacker',
        payload: JSON.stringify({ taskId: victimTask.id, dispatchId: attacker.id })
      }),
      (message) => logs.push(message)
    )

    expect(db.getTask(victimTask.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(victim.id)?.status).toBe('dispatched')
    expect(logs.at(-1)).toContain('Rejected escalation from term_attacker')
  })

  it('accepts the canonical sender of an imported federated Dispatch', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'remote escalation target' })
    const dispatch = db.createDispatchContext(task.id, 'remote-worker')

    applyEscalationToDispatch(
      db,
      db.insertMessage({
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
