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

  it('wakes only for the Run notify types and hands the rest over with the waking batch', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'Filtered wake',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab:22222222-2222-4222-8222-222222222222',
        notifyTypes: ['question']
      })
      const mailbox = `run:${run.id}`
      const insert = (type: 'status' | 'question') =>
        db.insertMessage({ runId: run.id, from: 'worker', to: mailbox, subject: type, type })
      const select = () =>
        selectOrchestrationPointerBatch({
          db,
          mailboxHandle: mailbox,
          waiters: undefined,
          reservedTypes: undefined
        })

      const status = insert('status')
      expect(select().messages).toEqual([])

      const question = insert('question')
      expect(select().messages.map((message) => message.id)).toEqual([status.id, question.id])
    } finally {
      db.close()
    }
  })

  it('silences wake pointers when the Run allow-list is empty', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'Silenced wake',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab:33333333-3333-4333-8333-333333333333',
        notifyTypes: []
      })
      const mailbox = `run:${run.id}`
      db.insertMessage({
        runId: run.id,
        from: 'worker',
        to: mailbox,
        subject: 'question',
        type: 'question'
      })

      expect(
        selectOrchestrationPointerBatch({
          db,
          mailboxHandle: mailbox,
          waiters: undefined,
          reservedTypes: undefined
        }).messages
      ).toEqual([])
    } finally {
      db.close()
    }
  })

  it('does not wake for a type a live waiter already claimed', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'Waiter claimed',
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: 'tab:44444444-4444-4444-8444-444444444444',
        notifyTypes: ['question']
      })
      const mailbox = `run:${run.id}`
      db.insertMessage({
        runId: run.id,
        from: 'worker',
        to: mailbox,
        subject: 'question',
        type: 'question'
      })

      expect(
        selectOrchestrationPointerBatch({
          db,
          mailboxHandle: mailbox,
          waiters: undefined,
          reservedTypes: new Set(['question'])
        }).messages
      ).toEqual([])
    } finally {
      db.close()
    }
  })
})
