import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('delivery eligibility derived from messages', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function setup() {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Derived delivery',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
    })
    const params = { runId: run.id, consumerGeneration: run.consumer_generation }
    const message = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: `run:${run.id}`,
      subject: 'old'
    })
    const first = db.getOrCreateRunDelivery(params)!
    return { run, params, message, first }
  }

  it.each(['read mutation', 'lifecycle suppression', 'direct SQL'])(
    '%s changes eligibility without updating the batch',
    (path) => {
      const { run, params, message, first } = setup()
      const before = db.getDeliveryRaw(first.delivery.id)
      if (path === 'read mutation') {
        db.markAsRead([message.id])
      } else if (path === 'lifecycle suppression') {
        db.markAsReadAndDelivered([message.id])
      } else {
        db.db.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(message.id)
      }
      expect(db.getDeliveryRaw(first.delivery.id)).toEqual(before)
      expect(db.hasOutstandingRunDelivery(run.id)).toBe(false)
      const changes = db.db.prepare('SELECT total_changes() AS n').get()
      expect(db.getOrCreateRunDelivery(params)).toBeUndefined()
      expect(db.db.prepare('SELECT total_changes() AS n').get()).toEqual(changes)
      expect(db.getDeliveryRaw(first.delivery.id)?.acknowledged_at).toBeNull()
    }
  )

  it('records only an actual acknowledgement, including after all messages were suppressed', () => {
    const { params, message, first } = setup()
    db.markAsReadAndDelivered([message.id])
    expect(db.getDeliveryRaw(first.delivery.id)?.acknowledged_at).toBeNull()
    const ack = { ...params, deliveryId: first.delivery.id }
    expect(db.acknowledgeRunDelivery(ack).duplicate).toBe(false)
    expect(db.getDeliveryRaw(first.delivery.id)?.acknowledged_at).not.toBeNull()
    expect(db.acknowledgeRunDelivery(ack).duplicate).toBe(true)
  })
})
