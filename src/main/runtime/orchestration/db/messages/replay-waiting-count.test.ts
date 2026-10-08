import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db'

describe('unread mail outside a Delivery', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  it('counts only unread current-contract mail in the selected Run and mailbox, with no limit', () => {
    const run = db.createRun({
      objective: 'count',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:pane'
    })
    const mailboxHandle = `run:${run.id}`
    const first = db.insertMessage({
      from: 'worker',
      to: mailboxHandle,
      runId: run.id,
      subject: 'first'
    })
    const delivery = db.getOrCreateRunDelivery({
      runId: run.id,
      consumerGeneration: run.consumer_generation
    })
    if (!delivery) {
      throw new Error('Expected Delivery')
    }
    const later = Array.from({ length: 79 }, (_, i) =>
      db.insertMessage({ from: 'worker', to: mailboxHandle, runId: run.id, subject: `later ${i}` })
    )
    db.markAsDelivered(later.map((row) => row.id))
    const read = db.insertMessage({
      from: 'worker',
      to: mailboxHandle,
      runId: run.id,
      subject: 'read'
    })
    db.markAsRead([read.id])
    for (const deliveryContract of ['audit_only', 'legacy_direct'] as const) {
      db.insertMessage({
        from: 'worker',
        to: mailboxHandle,
        runId: run.id,
        subject: deliveryContract,
        deliveryContract
      })
    }
    db.insertMessage({ from: 'worker', to: 'different', runId: run.id, subject: 'other address' })
    db.insertMessage({
      from: 'worker',
      to: mailboxHandle,
      runId: 'run_legacy_local',
      subject: 'other Run'
    })
    expect(
      db.countUnreadMessagesOutsideDelivery({
        runId: run.id,
        mailboxHandle,
        deliveryId: delivery.delivery.id
      })
    ).toBe(79)
    expect(db.countUnreadMessagesOutsideDelivery({ runId: run.id, mailboxHandle })).toBe(80)
    expect(db.getMessageById(first.id)?.read).toBe(0)
  })
})
