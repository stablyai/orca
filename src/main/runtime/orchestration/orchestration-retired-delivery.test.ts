import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'

describe('retired mailbox deliveries', () => {
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

  it('retires the heartbeat delivery atomically when completion suppresses its contents', () => {
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
    expect(db.getDeliveryRaw(first.delivery.id)?.status).toBe('acknowledged')
    expect(db.hasOutstandingRunDelivery(run.id)).toBe(false)
    expect(
      db
        .getOrCreateRunDelivery({ ...params, wakeTypes: ['worker_done'] })
        ?.messages.map((m) => m.id)
    ).toEqual([done.id])
    expect(db.acknowledgeRunDelivery({ ...params, deliveryId: first.delivery.id }).duplicate).toBe(
      true
    )
  })

  it('repairs an already fully-read outstanding delivery before replay', () => {
    const { params, insert } = setup()
    const old = insert('old')
    const first = db.getOrCreateRunDelivery(params)!
    db.db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(old.id)
    const next = insert('next')
    const current = db.getOrCreateRunDelivery(params)!
    expect(current.messages.map((m) => m.id)).toEqual([next.id])
    expect(current.replayed).toBe(false)
    expect(db.getDeliveryRaw(first.delivery.id)?.status).toBe('acknowledged')
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

  it('rolls retirement back with the enclosing lifecycle transaction', () => {
    const { params, insert } = setup()
    const message = insert('old')
    const first = db.getOrCreateRunDelivery(params)!
    db.db.exec('BEGIN')
    db.markAsReadAndDelivered([message.id])
    expect(db.getDeliveryRaw(first.delivery.id)?.status).toBe('acknowledged')
    db.db.exec('ROLLBACK')
    expect(db.getMessageById(message.id)?.read).toBe(0)
    expect(db.getDeliveryRaw(first.delivery.id)?.status).toBe('outstanding')
  })

  it('names the owning delivery when ack receives a message ID without consuming mail', () => {
    const { params, insert } = setup()
    const message = insert('pending')
    const first = db.getOrCreateRunDelivery(params)!
    expect(() => db.acknowledgeRunDelivery({ ...params, deliveryId: message.id })).toThrow(
      `Process the entire batch, then use --ack ${first.delivery.id}.`
    )
    expect(db.getMessageById(message.id)?.read).toBe(0)
    expect(db.getDeliveryRaw(first.delivery.id)?.status).toBe('outstanding')
  })

  it('does not reveal a delivery from another mailbox in a wrong-ID error', () => {
    const { params, insert } = setup()
    const foreign = db.createRun({
      objective: 'other',
      coordinatorHandle: 'other',
      coordinatorPaneKey: 'other:22222222-2222-4222-9222-222222222222'
    })
    const message = insert('private')
    const first = db.getOrCreateRunDelivery(params)!
    expect(() =>
      db.acknowledgeRunDelivery({
        runId: foreign.id,
        consumerGeneration: foreign.consumer_generation,
        deliveryId: message.id
      })
    ).toThrow('Run orchestration check to obtain the Delivery id.')
    expect(db.getDeliveryRaw(first.delivery.id)?.status).toBe('outstanding')
  })

  it.each(['markAsRead', 'markAsReadAndDelivered'] as const)(
    '%s retires dispatch mail without retiring a different mailbox',
    (method) => {
      const { run, params, insert } = setup()
      insert('coordinator mail')
      const coordinator = db.getOrCreateRunDelivery(params)!
      const task = db.createTask({ runId: run.id, spec: 'worker mail' })
      const dispatch = createRootDispatch(db, task.id, 'worker')
      const mailboxHandle = `dispatch:${dispatch.id}`
      const message = db.insertMessage({
        runId: run.id,
        from: 'term_coord',
        to: mailboxHandle,
        subject: 'worker mail'
      })
      const workerParams = { ...params, mailboxHandle }
      const worker = db.getOrCreateMailboxDelivery(workerParams)!
      db[method]([message.id])
      expect(db.getDeliveryRaw(worker.delivery.id)?.status).toBe('acknowledged')
      expect(db.getOrCreateMailboxDelivery(workerParams)).toBeUndefined()
      expect(db.getDeliveryRaw(coordinator.delivery.id)?.status).toBe('outstanding')
    }
  )
})
