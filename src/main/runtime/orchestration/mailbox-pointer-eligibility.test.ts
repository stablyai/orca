import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db/orchestration-db'
import {
  selectOrchestrationPointerBatch,
  shouldReleaseOrchestrationPointer,
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
  it('selects new mail behind a fetched batch before limiting the notice rows', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const run = db.createRun({
        objective: 'Read a full batch',
        coordinatorHandle: 'coordinator',
        coordinatorPaneKey: 'tab:leaf'
      })
      const mailbox = `run:${run.id}`
      db.insertMessages(
        Array.from({ length: 50 }, (_, index) => ({
          runId: run.id,
          from: 'worker',
          to: mailbox,
          subject: `Fetched ${index}`
        }))
      )
      const fetched = db.getOrCreateRunDelivery({
        runId: run.id,
        consumerGeneration: run.consumer_generation
      })
      expect(fetched?.messages).toHaveLength(50)
      const newer = db.insertMessage({
        runId: run.id,
        from: 'worker',
        to: mailbox,
        subject: 'New mail'
      })
      expect(
        selectOrchestrationPointerBatch({
          db,
          mailboxHandle: mailbox,
          waiters: undefined,
          reservedTypes: undefined
        }).map((message) => message.id)
      ).toEqual([newer.id])
      expect(shouldReleaseOrchestrationPointer(db, mailbox, [newer], undefined)).toBe(false)
      expect(
        shouldReleaseOrchestrationPointer(db, mailbox, fetched?.messages ?? [], undefined)
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  it('excludes a waiter-claimed type', () => {
    const db = seeded()
    try {
      const batch = selectOrchestrationPointerBatch({
        db,
        mailboxHandle: MAILBOX,
        waiters: waiters(['question']),
        reservedTypes: undefined
      })
      expect(batch.map((m) => m.type)).toEqual(['status', 'status'])
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
      expect(batch.map((m) => m.type)).toEqual(['question'])
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
        })
      ).toEqual([])
    } finally {
      db.close()
    }
  })

  // An unfiltered waiter owns the mailbox: a caller blocked in `check --wait` preempts delivery.
  it('yields nothing when any waiter is unfiltered', () => {
    const db = seeded()
    try {
      expect(
        selectOrchestrationPointerBatch({
          db,
          mailboxHandle: MAILBOX,
          waiters: waiters(['question'], undefined),
          reservedTypes: undefined
        })
      ).toEqual([])
    } finally {
      db.close()
    }
  })
})
