import { afterEach, describe, expect, it } from 'vitest'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT, OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'
import { selectOrchestrationPointerBatch } from './mailbox-pointer-eligibility'
import type { DispatchContextRow, MessageRow } from './types'

/**
 * A heartbeat is state the coordinator reads, not mail that wakes it (#14910).
 *
 * These run against a real database because the exclusion lives in SQL: the rows are never
 * delivered and never read, so they pile up at the head of `sequence` and a JS filter applied
 * after LIMIT would still starve the push.
 */

const WORKER = 'term_worker'
const MAILBOX = `run:${'r'.repeat(8)}`

type Fixture = { db: OrchestrationDb; dispatch: DispatchContextRow }

function dispatched(): Fixture {
  const db = new OrchestrationDb(':memory:')
  const task = db.createTask({ spec: 'work' })
  return { db, dispatch: createRootDispatch(db, task.id, WORKER, 'tab_w:leaf_w') }
}

function sendHeartbeat(
  { db, dispatch }: Fixture,
  options: { from?: string; senderPaneKey?: string } = {}
): MessageRow {
  const message = db.insertMessage({
    from: options.from ?? WORKER,
    to: MAILBOX,
    subject: 'alive',
    type: 'heartbeat',
    payload: JSON.stringify({ dispatchId: dispatch.id }),
    senderPaneKey: options.senderPaneKey ?? 'tab_w:leaf_w'
  })
  // The send path reconciles before any pointer runs; this is that step.
  reconcileLifecycleMessage(db, message)
  return message
}

function pointerBatch(db: OrchestrationDb): MessageRow[] {
  return selectOrchestrationPointerBatch({
    db,
    mailboxHandle: MAILBOX,
    waiters: undefined,
    reservedTypes: undefined
  })
}

describe('heartbeat push silence', () => {
  let fixture: Fixture | undefined

  afterEach(() => fixture?.db.close())

  it('records liveness without offering the heartbeat to the pointer', () => {
    fixture = dispatched()
    const message = sendHeartbeat(fixture)

    expect(pointerBatch(fixture.db)).toEqual([])
    expect(fixture.db.getDispatchContextById(fixture.dispatch.id)?.last_heartbeat_at).toBe(
      message.created_at
    )
  })

  it('keeps a silenced heartbeat readable by check', () => {
    fixture = dispatched()
    sendHeartbeat(fixture)

    expect(fixture.db.getUnreadMessages(MAILBOX).map((m) => m.type)).toEqual(['heartbeat'])
    expect(fixture.db.getUnreadMessages(MAILBOX, ['heartbeat'])).toHaveLength(1)
  })

  it('still pushes a non-heartbeat that shares the mailbox', () => {
    fixture = dispatched()
    sendHeartbeat(fixture)
    fixture.db.insertMessage({
      from: WORKER,
      to: MAILBOX,
      subject: 'blocked on a decision',
      type: 'escalation'
    })

    expect(pointerBatch(fixture.db).map((m) => m.type)).toEqual(['escalation'])
  })

  it('pushes a rejected heartbeat, because it is a claim and not liveness', () => {
    fixture = dispatched()
    const rejected = sendHeartbeat(fixture, {
      from: 'term_foreign',
      senderPaneKey: 'tab_f:leaf_f'
    })

    expect(pointerBatch(fixture.db).map((m) => m.id)).toEqual([rejected.id])
    expect(fixture.db.getDispatchContextById(fixture.dispatch.id)?.last_heartbeat_at).toBeNull()
  })

  it('does not let a full page of heartbeats starve a worker_done behind them', () => {
    fixture = dispatched()
    for (let i = 0; i <= ORCHESTRATION_DELIVERY_BATCH_LIMIT; i++) {
      sendHeartbeat(fixture)
    }
    const done = fixture.db.insertMessage({
      from: WORKER,
      to: MAILBOX,
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ dispatchId: fixture.dispatch.id, outcome: 'succeeded' })
    })

    expect(pointerBatch(fixture.db).map((m) => m.id)).toEqual([done.id])
  })
})
