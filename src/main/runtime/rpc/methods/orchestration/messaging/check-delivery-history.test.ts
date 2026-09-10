import { afterEach, describe, expect, it } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

describe('Run delivery history', () => {
  const h = createOrchestrationRpcHarness()
  afterEach(() => h.cleanup())

  it('exposes the outstanding delivery without minting or acknowledging it', async () => {
    const { db, ctx, activeRunId } = h.setup()
    const params = { terminal: 'term_coord', run: activeRunId, all: true }
    db.insertMessage({
      from: 'worker',
      to: `run:${activeRunId}`,
      runId: activeRunId,
      subject: 'waiting'
    })
    expect(await h.call('orchestration.check', params, ctx)).toMatchObject({
      deliveryId: null,
      count: 1
    })
    expect(db.hasOutstandingRunDelivery(activeRunId!)).toBe(false)
    const delivery = db.getOrCreateRunDelivery({
      runId: activeRunId!,
      consumerGeneration: db.getRun(activeRunId!)!.consumer_generation
    })!
    expect(await h.call('orchestration.check', { ...params, format: true }, ctx)).toMatchObject({
      deliveryId: delivery.delivery.id,
      count: 1
    })
    expect(db.getDeliveryRaw(delivery.delivery.id)?.status).toBe('outstanding')
    expect(db.getMessageById(delivery.messages[0].id)?.read).toBe(0)
  })
})
