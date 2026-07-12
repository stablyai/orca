import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'

describe('lifecycle reconciliation', () => {
  let db: OrchestrationDb

  afterEach(() => db?.close())

  it('completes an active dispatch from payload IDs after its terminal handle is reminted', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_before_restart')
    const logs: string[] = []
    const message = db.insertMessage({
      from: 'term_after_restart',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id })
    })

    expect(reconcileLifecycleMessage(db, message, (line) => logs.push(line))).toEqual({
      action: 'completed',
      taskId: task.id,
      dispatchId: dispatch.id
    })
    expect(db.getTask(task.id)?.status).toBe('completed')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(logs.some((line) => line.includes('accepting payload provenance'))).toBe(true)
  })

  // Real leaf UUIDs: pane keys are `${tabId}:${leafUuid}` and only the leaf
  // half is identity (the tab half changes on pane break-out).
  const LEAF_A = '11111111-1111-1111-8111-111111111111'
  const LEAF_B = '22222222-2222-4222-9222-222222222222'

  it('completes worker_done from the dispatched pane after a handle remint', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_before_restart', `tab_w:${LEAF_A}`)
    const message = db.insertMessage({
      from: 'term_after_restart',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id }),
      senderPaneKey: `tab_w:${LEAF_A}`
    })

    expect(reconcileLifecycleMessage(db, message).action).toBe('completed')
    expect(db.getTask(task.id)?.status).toBe('completed')
  })

  it('completes worker_done from the same leaf after a pane break-out changed the tab half', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    // Dispatch recorded the post-break-out pane key; the worker shell still
    // holds the spawn-time key with the old tab id.
    const dispatch = db.createDispatchContext(task.id, 'term_before_restart', `tab_new:${LEAF_A}`)
    const message = db.insertMessage({
      from: 'term_after_restart',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id }),
      senderPaneKey: `tab_old:${LEAF_A}`
    })

    expect(reconcileLifecycleMessage(db, message).action).toBe('completed')
    expect(db.getTask(task.id)?.status).toBe('completed')
  })

  it('completes worker_done when a pane key is unparseable (legacy format)', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_owner', `tab_w:${LEAF_A}`)
    const message = db.insertMessage({
      from: 'term_reminted',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id }),
      senderPaneKey: 'tab_w:42'
    })

    expect(reconcileLifecycleMessage(db, message).action).toBe('completed')
  })

  it('ignores worker_done sent from a different pane', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_owner', `tab_w1:${LEAF_A}`)
    const logs: string[] = []
    const message = db.insertMessage({
      from: 'term_other_worker',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id }),
      senderPaneKey: `tab_w2:${LEAF_B}`
    })

    expect(reconcileLifecycleMessage(db, message, (line) => logs.push(line))).toEqual({
      action: 'ignored'
    })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    expect(logs.some((line) => line.includes(`expected pane tab_w1:${LEAF_A}`))).toBe(true)
  })

  it('ignores a heartbeat sent from a different pane without recording liveness', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_owner', `tab_w1:${LEAF_A}`)
    const heartbeat = db.insertMessage({
      from: 'term_other_worker',
      to: 'term_coordinator',
      subject: 'alive',
      type: 'heartbeat',
      payload: JSON.stringify({ dispatchId: dispatch.id }),
      senderPaneKey: `tab_w2:${LEAF_B}`
    })

    expect(reconcileLifecycleMessage(db, heartbeat)).toEqual({ action: 'ignored' })
    expect(db.getDispatchContextById(dispatch.id)?.last_heartbeat_at).toBeNull()
  })

  it('records a heartbeat whose pane key drifted only in the tab half', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_owner', `tab_new:${LEAF_A}`)
    const heartbeat = db.insertMessage({
      from: 'term_owner',
      to: 'term_coordinator',
      subject: 'alive',
      type: 'heartbeat',
      payload: JSON.stringify({ dispatchId: dispatch.id }),
      senderPaneKey: `tab_old:${LEAF_A}`
    })

    expect(reconcileLifecycleMessage(db, heartbeat)).toEqual({
      action: 'heartbeat_recorded',
      dispatchId: dispatch.id
    })
    expect(db.getDispatchContextById(dispatch.id)?.last_heartbeat_at).not.toBeNull()
  })

  it('suppresses same-dispatch heartbeats once worker_done is reconciled', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker')
    const otherTask = db.createTask({ spec: 'other work' })
    const otherDispatch = db.createDispatchContext(otherTask.id, 'term_other')
    const insertHeartbeat = (dispatchId: string, from: string) =>
      db.insertMessage({
        from,
        to: 'term_coordinator',
        subject: 'alive',
        type: 'heartbeat',
        payload: JSON.stringify({ dispatchId })
      })
    const staleHeartbeat = insertHeartbeat(dispatch.id, 'term_worker')
    const otherHeartbeat = insertHeartbeat(otherDispatch.id, 'term_other')
    reconcileLifecycleMessage(db, staleHeartbeat)
    reconcileLifecycleMessage(db, otherHeartbeat)
    const done = db.insertMessage({
      from: 'term_worker',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id })
    })

    reconcileLifecycleMessage(db, done)

    expect(db.getUnreadMessages('term_coordinator', ['heartbeat']).map((row) => row.id)).toEqual([
      otherHeartbeat.id
    ])
    const archived = db
      .getAllMessagesForHandle('term_coordinator')
      .find((row) => row.id === staleHeartbeat.id)
    expect(archived).toMatchObject({ read: 1 })
    expect(archived?.delivered_at).not.toBeNull()

    const lateHeartbeat = insertHeartbeat(dispatch.id, 'term_worker')
    expect(reconcileLifecycleMessage(db, lateHeartbeat)).toEqual({ action: 'suppressed' })
    expect(db.getMessageById(lateHeartbeat.id)).toMatchObject({ read: 1 })
    expect(db.getMessageById(lateHeartbeat.id)?.delivered_at).not.toBeNull()
  })
})
