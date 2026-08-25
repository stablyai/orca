import { afterEach, describe, expect, it } from 'vitest'
import { openDecisionGateFromMessage } from './coordinator-decision-gates'
import { OrchestrationDb } from './db'

describe('coordinator decision-gate authority', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('opens a gate only for the sender-owned active Dispatch', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'owned gate target' })
    const dispatch = db.createDispatchContext(task.id, 'term_owner', 'tab_owner:leaf_owner')
    const logs: string[] = []

    openDecisionGateFromMessage(
      db,
      db.insertMessage({
        from: 'term_owner',
        to: 'term_coordinator',
        subject: 'Need approval',
        type: 'decision_gate',
        senderPaneKey: 'tab_owner:leaf_owner',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          question: 'Proceed?'
        })
      }),
      (message) => logs.push(message)
    )

    expect(db.listGates({ taskId: task.id })).toHaveLength(1)
    expect(db.getTask(task.id)?.status).toBe('blocked')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(logs.at(-1)).toBe(`Task ${task.id} blocked on decision gate`)
  })

  it('rejects a gate targeting another active Dispatch without mutating either Task', () => {
    db = new OrchestrationDb(':memory:')
    const attackerTask = db.createTask({ spec: 'attacker assignment' })
    const attacker = db.createDispatchContext(
      attackerTask.id,
      'term_attacker',
      'tab_attacker:leaf_attacker'
    )
    const victimTask = db.createTask({ spec: 'victim assignment' })
    const victim = db.createDispatchContext(victimTask.id, 'term_victim', 'tab_victim:leaf_victim')
    const logs: string[] = []

    openDecisionGateFromMessage(
      db,
      db.insertMessage({
        from: 'term_attacker',
        to: 'term_coordinator',
        subject: 'Block the victim',
        type: 'decision_gate',
        senderPaneKey: 'tab_attacker:leaf_attacker',
        payload: JSON.stringify({
          taskId: victimTask.id,
          dispatchId: attacker.id,
          question: 'Stop?'
        })
      }),
      (message) => logs.push(message)
    )

    expect(db.listGates({ taskId: victimTask.id })).toHaveLength(0)
    expect(db.getTask(attackerTask.id)?.status).toBe('dispatched')
    expect(db.getTask(victimTask.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(attacker.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(victim.id)?.status).toBe('dispatched')
    expect(logs.at(-1)).toContain('Rejected decision gate from term_attacker')
  })

  it('accepts the canonical sender of an imported federated Dispatch', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'remote gate target' })
    const dispatch = db.createDispatchContext(task.id, 'remote-worker')

    openDecisionGateFromMessage(
      db,
      db.insertMessage({
        from: `dispatch:${dispatch.id}`,
        to: 'term_coordinator',
        subject: 'Remote approval required',
        type: 'decision_gate',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          question: 'Proceed remotely?'
        })
      }),
      () => {}
    )

    expect(db.listGates({ taskId: task.id })).toHaveLength(1)
    expect(db.getTask(task.id)?.status).toBe('blocked')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
  })
})
