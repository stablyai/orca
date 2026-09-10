import { afterEach, describe, expect, it } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'

describe('Run delivery history', () => {
  const h = createOrchestrationRpcHarness()
  afterEach(() => h.cleanup())

  it('does not label filtered history as an acknowledgeable delivery', async () => {
    const { db, ctx, activeRunId } = h.setup()
    const params = { terminal: 'term_coord', run: activeRunId, all: true }
    db.insertMessage({
      from: 'worker',
      to: `run:${activeRunId}`,
      runId: activeRunId,
      subject: 'waiting'
    })
    expect(await h.call('orchestration.check', params, ctx)).toMatchObject({
      count: 1
    })
    expect(db.hasOutstandingRunDelivery(activeRunId!)).toBe(false)
    const delivery = db.getOrCreateRunDelivery({
      runId: activeRunId!,
      consumerGeneration: db.getRun(activeRunId!)!.consumer_generation
    })!
    db.insertMessage({
      from: 'worker',
      to: `run:${activeRunId}`,
      runId: activeRunId,
      subject: 'later completion',
      type: 'worker_done'
    })
    const history = await h.call(
      'orchestration.check',
      {
        ...params,
        format: true,
        types: 'worker_done'
      },
      ctx
    )
    expect(history).toMatchObject({ count: 1, messages: [{ subject: 'later completion' }] })
    expect(history).not.toHaveProperty('deliveryId')
    expect(db.getDeliveryRaw(delivery.delivery.id)?.status).toBe('outstanding')
    expect(db.getMessageById(delivery.messages[0].id)?.read).toBe(0)
  })
})
