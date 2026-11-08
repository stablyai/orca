import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../db/orchestration-db'
import { selectOrchestrationPointerBatch } from './mailbox-pointer-eligibility'

describe('selectOrchestrationPointerBatch', () => {
  it('selects only mail outside the unacked batch, and reselects behind the next one after an ack', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'Held batch',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
      })
      const mailbox = `run:${run.id}`
      const params = {
        runId: run.id,
        mailboxHandle: mailbox,
        consumerGeneration: run.consumer_generation
      }
      const insert = (subject: string) =>
        db.insertMessage({ runId: run.id, from: 'worker', to: mailbox, subject })
      const heldMessage = insert('held')
      const first = db.getOrCreateMailboxDelivery(params)!.delivery
      const newer = insert('newer')
      const select = () =>
        selectOrchestrationPointerBatch({
          db,
          mailboxHandle: mailbox,
          waiters: undefined,
          reservedTypes: undefined
        })

      const batch = select()
      expect(batch.heldDeliveryId).toBe(first.id)
      expect(batch.messages.map((message) => message.id)).toEqual([newer.id])
      expect(db.getMessageById(heldMessage.id)).toMatchObject({ read: 0, delivered_at: null })

      db.acknowledgeMailboxDelivery({ ...params, deliveryId: first.id })
      const second = db.getOrCreateMailboxDelivery(params)!.delivery
      const later = insert('later')
      expect(select()).toEqual({
        heldDeliveryId: second.id,
        messages: [expect.objectContaining({ id: later.id })]
      })
    } finally {
      db.close()
    }
  })
})
