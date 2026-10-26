import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db/orchestration-db'
import {
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'

/**
 * Exclusion is applied ONLY in SQL. It used to be applied a second time in JS, which meant a broken
 * SQL predicate still produced a correct batch — so these cases run against a real database rather
 * than a stub, and fail if the SQL exclusion stops carrying the whole contract.
 */
const MAILBOX = 'dispatch:d1'

function seeded(): OrchestrationDb {
  const db = new OrchestrationDb(':memory:')
  db.insertMessages([
    { runId: 'run_legacy_local', from: 'coordinator', to: MAILBOX, subject: 'a', type: 'status' },
    { runId: 'run_legacy_local', from: 'coordinator', to: MAILBOX, subject: 'b', type: 'question' },
    { runId: 'run_legacy_local', from: 'coordinator', to: MAILBOX, subject: 'c', type: 'status' }
  ])
  return db
}

function waiters(...filters: (string[] | undefined)[]): ReadonlySet<OrchestrationMessageWaiter> {
  return new Set(filters.map((typeFilter) => ({ typeFilter })))
}

describe('selectOrchestrationPointerBatch', () => {
  it('excludes a waiter-claimed type', () => {
    const db = seeded()
    try {
      const batch = selectOrchestrationPointerBatch({
        db,
        mailboxHandle: MAILBOX,
        waiters: waiters(['question']),
        reservedTypes: undefined
      })
      expect(batch.messages.map((m) => m.type)).toEqual(['status', 'status'])
    } finally {
      db.close()
    }
  })

  it('excludes a reserved type', () => {
    const db = seeded()
    try {
      const batch = selectOrchestrationPointerBatch({
        db,
        mailboxHandle: MAILBOX,
        waiters: undefined,
        reservedTypes: new Set(['status'])
      })
      expect(batch.messages.map((m) => m.type)).toEqual(['question'])
    } finally {
      db.close()
    }
  })

  it('unions reserved types with every waiter filter', () => {
    const db = seeded()
    try {
      expect(
        selectOrchestrationPointerBatch({
          db,
          mailboxHandle: MAILBOX,
          waiters: waiters(['question']),
          reservedTypes: new Set(['status'])
        }).messages
      ).toEqual([])
    } finally {
      db.close()
    }
  })

  // An unfiltered check --wait owns the entire mailbox and preempts pointer delivery.
  it('yields nothing when any waiter is unfiltered', () => {
    const db = seeded()
    try {
      expect(
        selectOrchestrationPointerBatch({
          db,
          mailboxHandle: MAILBOX,
          waiters: waiters(['question'], undefined),
          reservedTypes: undefined
        }).messages
      ).toEqual([])
    } finally {
      db.close()
    }
  })

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
