import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'

describe('mailbox delivery consumption', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function setup() {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Retired delivery',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
    })
    const params = { runId: run.id, consumerGeneration: run.consumer_generation }
    const insert = (subject: string) =>
      db.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject })
    return { run, params, insert }
  }

  it('advances past a heartbeat batch when completion suppresses its contents', () => {
    const { run, params } = setup()
    const task = db.createTask({ runId: run.id, spec: 'work' })
    const dispatch = createRootDispatch(db, task.id, 'worker')
    const insert = (type: 'heartbeat' | 'worker_done') =>
      db.insertMessage({
        runId: run.id,
        from: 'worker',
        to: `run:${run.id}`,
        subject: type,
        type,
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
      })
    insert('heartbeat')
    const first = db.getOrCreateRunDelivery(params)!
    const done = insert('worker_done')
    expect(reconcileLifecycleMessage(db, done).action).toBe('completed')
    expect(db.getDeliveryRaw(first.delivery.id)?.acknowledged_at).toBeNull()
    expect(db.hasOutstandingRunDelivery(run.id)).toBe(false)
    expect(
      db
        .getOrCreateRunDelivery({ ...params, wakeTypes: ['worker_done'] })
        ?.messages.map((m) => m.id)
    ).toEqual([done.id])
    expect(db.acknowledgeRunDelivery({ ...params, deliveryId: first.delivery.id }).duplicate).toBe(
      false
    )
  })

  it('ignores a fully read batch without rewriting it', () => {
    const { params, insert } = setup()
    const old = insert('old')
    const first = db.getOrCreateRunDelivery(params)!
    db.db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(old.id)
    const next = insert('next')
    const current = db.getOrCreateRunDelivery(params)!
    expect(current.messages.map((m) => m.id)).toEqual([next.id])
    expect(current.replayed).toBe(false)
    expect(db.getDeliveryRaw(first.delivery.id)?.acknowledged_at).toBeNull()
  })

  it('preserves the entire replay batch while any member is unread', () => {
    const { params, insert } = setup()
    const a = insert('a')
    const b = insert('b')
    const first = db.getOrCreateRunDelivery(params)!
    db.markAsReadAndDelivered([a.id])
    insert('later')
    const replay = db.getOrCreateRunDelivery(params)!
    expect(replay.delivery.id).toBe(first.delivery.id)
    expect(replay.messages.map((m) => m.id)).toEqual([a.id, b.id])
    expect(replay.replayed).toBe(true)
  })

  it('derives eligibility again when a read transaction rolls back', () => {
    const { params, insert } = setup()
    const message = insert('old')
    const first = db.getOrCreateRunDelivery(params)!
    const before = db.getDeliveryRaw(first.delivery.id)
    db.db.exec('BEGIN')
    db.markAsReadAndDelivered([message.id])
    expect(db.getDeliveryRaw(first.delivery.id)?.acknowledged_at).toBeNull()
    expect(db.hasOutstandingRunDelivery(params.runId)).toBe(false)
    db.db.exec('ROLLBACK')
    expect(db.hasOutstandingRunDelivery(params.runId)).toBe(true)
    expect(db.getDeliveryRaw(first.delivery.id)).toEqual(before)
    expect(db.getMessageById(message.id)?.read).toBe(0)
    expect(db.getDeliveryRaw(first.delivery.id)?.acknowledged_at).toBeNull()
  })

  it('explains the delivery ID contract for invalid acknowledgements without consuming mail', () => {
    const { params, insert } = setup()
    const message = insert('pending')
    const first = db.getOrCreateRunDelivery(params)!
    expect(() => db.acknowledgeRunDelivery({ ...params, deliveryId: message.id })).toThrow(
      '--ack requires a delivery_* ID returned by orchestration check; process the entire batch before acknowledging.'
    )
    expect(db.getMessageById(message.id)?.read).toBe(0)
    expect(db.getDeliveryRaw(first.delivery.id)?.acknowledged_at).toBeNull()
  })

  it('checks the consumer generation even when the prior batch is already read', () => {
    const { run, params, insert } = setup()
    const message = insert('old')
    const first = db.getOrCreateRunDelivery(params)!
    db.db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(message.id)
    expect(() =>
      db.getOrCreateMailboxDelivery({
        ...params,
        mailboxHandle: `run:${run.id}`,
        consumerGeneration: params.consumerGeneration + 1
      })
    ).toThrow(expect.objectContaining({ code: 'consumer_fenced' }))
    expect(db.getDeliveryRaw(first.delivery.id)?.acknowledged_at).toBeNull()
  })

  it.each(['markAsRead', 'markAsReadAndDelivered'] as const)(
    '%s releases dispatch mail without changing a different mailbox',
    (method) => {
      const { run, params, insert } = setup()
      insert('coordinator mail')
      db.getOrCreateRunDelivery(params)!
      const task = db.createTask({ runId: run.id, spec: 'worker mail' })
      const dispatch = createRootDispatch(db, task.id, 'worker')
      const mailboxHandle = `dispatch:${dispatch.id}`
      const message = db.insertMessage({
        runId: run.id,
        from: 'term_coord',
        to: mailboxHandle,
        subject: 'worker mail'
      })
      const workerParams = {
        ...params,
        mailboxHandle,
        consumerGeneration: dispatch.consumer_generation
      }
      db.getOrCreateMailboxDelivery(workerParams)!
      db[method]([message.id])
      expect(db.hasOutstandingMailboxDelivery(mailboxHandle)).toBe(false)
      expect(db.getOrCreateMailboxDelivery(workerParams)).toBeUndefined()
      expect(db.hasOutstandingRunDelivery(run.id)).toBe(true)
    }
  )
})
