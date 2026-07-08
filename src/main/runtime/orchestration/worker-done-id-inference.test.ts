import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'

describe('worker_done id inference', () => {
  let db: OrchestrationDb

  afterEach(() => db?.close())

  it('completes the active dispatch when both ids are omitted', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker')
    const message = db.insertMessage({
      from: 'term_worker',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ filesModified: ['src/change.ts'] })
    })

    expect(reconcileLifecycleMessage(db, message)).toEqual({
      action: 'completed',
      taskId: task.id,
      dispatchId: dispatch.id
    })
    expect(JSON.parse(db.getTask(task.id)?.result ?? '{}')).toMatchObject({
      completedBy: 'term_worker',
      filesModified: ['src/change.ts']
    })
  })

  it('uses stable pane identity when ids are null and the handle changed', () => {
    db = new OrchestrationDb(':memory:')
    const leafId = '11111111-1111-4111-8111-111111111111'
    const task = db.createTask({ spec: 'work after restart' })
    const dispatch = db.createDispatchContext(task.id, 'term_before', `tab_old:${leafId}`)
    const message = db.insertMessage({
      from: 'term_after',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: null, dispatchId: null }),
      senderPaneKey: `tab_new:${leafId}`
    })

    expect(reconcileLifecycleMessage(db, message)).toEqual({
      action: 'completed',
      taskId: task.id,
      dispatchId: dispatch.id
    })
  })

  it.each([
    ['taskId', 'task_other'],
    ['dispatchId', 'ctx_other']
  ])('ignores a supplied %s that conflicts with the active dispatch', (field, value) => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker')
    const message = db.insertMessage({
      from: 'term_worker',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ [field]: value })
    })

    expect(reconcileLifecycleMessage(db, message)).toEqual({ action: 'ignored' })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  it.each(['{bad json', 'null', '[]'])('does not infer ids from invalid payload %s', (payload) => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'work' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker')
    const message = db.insertMessage({
      from: 'term_worker',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload
    })

    expect(reconcileLifecycleMessage(db, message)).toEqual({ action: 'ignored' })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  it('rejects id inference when a foreign pane claims the assignee handle', () => {
    db = new OrchestrationDb(':memory:')
    const ownerLeaf = '11111111-1111-4111-8111-111111111111'
    const foreignLeaf = '22222222-2222-4222-8222-222222222222'
    const task = db.createTask({ spec: 'owned work' })
    const dispatch = db.createDispatchContext(task.id, 'term_worker', `tab_owner:${ownerLeaf}`)
    const message = db.insertMessage({
      from: 'term_worker',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({}),
      senderPaneKey: `tab_foreign:${foreignLeaf}`
    })

    expect(reconcileLifecycleMessage(db, message)).toMatchObject({
      action: 'rejected',
      code: 'sender_not_assignee'
    })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })

  it('ignores an id-less completion when the sender has no active dispatch', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ spec: 'other work' })
    const dispatch = db.createDispatchContext(task.id, 'term_other')
    const message = db.insertMessage({
      from: 'term_worker',
      to: 'term_coordinator',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({})
    })

    expect(reconcileLifecycleMessage(db, message)).toEqual({ action: 'ignored' })
    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
  })
})
