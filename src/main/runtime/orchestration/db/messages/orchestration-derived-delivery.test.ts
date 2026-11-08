import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import './mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'

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
