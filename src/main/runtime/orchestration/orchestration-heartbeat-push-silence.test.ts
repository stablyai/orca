import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT, OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { reconcileLifecycleMessage } from './lifecycle-reconciliation'
import { selectOrchestrationPointerBatch } from './mailbox-pointer-eligibility'
import {
  OrchestrationStructuredMailboxPointerDelivery,
  type StructuredMailboxPointerHost
} from './structured-mailbox-pointer-delivery'
import type { DispatchContextRow, MessageRow } from './types'

/**
 * A heartbeat is state the coordinator reads, not mail that wakes it (#14910).
 *
 * These run against a real database because the exclusion lives in SQL: the rows are never
 * delivered and never read, so they pile up at the head of `sequence` and a JS filter applied
 * after LIMIT would still starve the push.
 */

const WORKER = 'term_worker'

/** `mailbox` is the coordinator's `run:` mailbox, where a worker's heartbeat lands. */
type Fixture = { db: OrchestrationDb; dispatch: DispatchContextRow; mailbox: string }

function dispatched(): Fixture {
  const db = new OrchestrationDb(':memory:')
  const run = db.createRun({
    objective: 'work',
    coordinatorHandle: 'term_coordinator',
    coordinatorPaneKey: 'tab_c:leaf_c'
  })
  const task = db.createTask({ spec: 'work', runId: run.id })
  return {
    db,
    dispatch: createRootDispatch(db, task.id, WORKER, 'tab_w:leaf_w'),
    mailbox: `run:${run.id}`
  }
}

function sendHeartbeat(
  { db, dispatch, mailbox }: Fixture,
  options: { from?: string; senderPaneKey?: string } = {}
): MessageRow {
  const message = db.insertMessage({
    from: options.from ?? WORKER,
    to: mailbox,
    subject: 'alive',
    type: 'heartbeat',
    payload: JSON.stringify({ dispatchId: dispatch.id }),
    senderPaneKey: options.senderPaneKey ?? 'tab_w:leaf_w'
  })
  // The send path reconciles before any pointer runs; this is that step.
  reconcileLifecycleMessage(db, message)
  return message
}

function pointerBatch({ db, mailbox }: Fixture): MessageRow[] {
  return selectOrchestrationPointerBatch({
    db,
    mailboxHandle: mailbox,
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

    expect(pointerBatch(fixture)).toEqual([])
    expect(fixture.db.getDispatchContextById(fixture.dispatch.id)?.last_heartbeat_at).toBe(
      message.created_at
    )
  })

  it('keeps a silenced heartbeat readable by check', () => {
    fixture = dispatched()
    sendHeartbeat(fixture)

    expect(fixture.db.getUnreadMessages(fixture.mailbox).map((m) => m.type)).toEqual(['heartbeat'])
    expect(fixture.db.getUnreadMessages(fixture.mailbox, ['heartbeat'])).toHaveLength(1)
  })

  it('still pushes a non-heartbeat that shares the mailbox', () => {
    fixture = dispatched()
    sendHeartbeat(fixture)
    fixture.db.insertMessage({
      from: WORKER,
      to: fixture.mailbox,
      subject: 'blocked on a decision',
      type: 'escalation'
    })

    expect(pointerBatch(fixture).map((m) => m.type)).toEqual(['escalation'])
  })

  it('pushes a rejected heartbeat, because it is a claim and not liveness', () => {
    fixture = dispatched()
    const rejected = sendHeartbeat(fixture, {
      from: 'term_foreign',
      senderPaneKey: 'tab_f:leaf_f'
    })

    expect(pointerBatch(fixture).map((m) => m.id)).toEqual([rejected.id])
    expect(fixture.db.getDispatchContextById(fixture.dispatch.id)?.last_heartbeat_at).toBeNull()
  })

  it('does not let a full page of heartbeats starve a worker_done behind them', () => {
    fixture = dispatched()
    for (let i = 0; i <= ORCHESTRATION_DELIVERY_BATCH_LIMIT; i++) {
      sendHeartbeat(fixture)
    }
    const done = fixture.db.insertMessage({
      from: WORKER,
      to: fixture.mailbox,
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ dispatchId: fixture.dispatch.id, outcome: 'succeeded' })
    })

    expect(pointerBatch(fixture).map((m) => m.id)).toEqual([done.id])
  })
})

describe('heartbeat push silence on the structured-session lane', () => {
  let fixture: Fixture | undefined

  afterEach(() => fixture?.db.close())

  // A structured coordinator owns its `run:` mailbox through this lane, so it must share the filter.
  function structuredCoordinatorLane({ db, mailbox }: Fixture) {
    const send = vi.fn<StructuredMailboxPointerHost['send']>(async () => ({
      kind: 'sent',
      state: 'accepted'
    }))
    const delivery = new OrchestrationStructuredMailboxPointerDelivery({
      getDb: () => db,
      getMessageWaiters: () => undefined,
      resolveStructuredTarget: (handle) =>
        handle === mailbox ? { sessionId: 'session-c', dispatchId: null } : null,
      getCliCommand: () => 'orca-dev',
      host: {
        readGateFacts: async () => ({ turnRunning: false, awaitingHuman: false, submissions: [] }),
        currentFence: () => 1,
        send
      }
    })
    return { delivery, send }
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('does not spend a coordinator turn on a recorded heartbeat', async () => {
    fixture = dispatched()
    sendHeartbeat(fixture)
    const { delivery, send } = structuredCoordinatorLane(fixture)

    delivery.deliverForHandle(fixture.mailbox)
    await flush()

    expect(send).not.toHaveBeenCalled()
    expect(fixture.db.getUnreadMessages(fixture.mailbox).map((m) => m.type)).toEqual(['heartbeat'])
  })

  it('consumes only the non-heartbeat mail it pushed', async () => {
    fixture = dispatched()
    const heartbeat = sendHeartbeat(fixture)
    const escalation = fixture.db.insertMessage({
      from: WORKER,
      to: fixture.mailbox,
      subject: 'blocked on a decision',
      type: 'escalation'
    })
    const { delivery, send } = structuredCoordinatorLane(fixture)

    delivery.deliverForHandle(fixture.mailbox)
    await flush()

    expect(send).toHaveBeenCalledTimes(1)
    const pending = fixture.db.getUndeliveredUnreadMessages(fixture.mailbox).map((m) => m.id)
    expect(pending).toContain(heartbeat.id)
    expect(pending).not.toContain(escalation.id)
  })
})
