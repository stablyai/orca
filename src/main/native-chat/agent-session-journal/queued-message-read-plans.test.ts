import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { SqliteBindings } from '../../sqlite/sqlite-statement'
import {
  dispatchedQueuedMessageHeader,
  expiredDispatchedQueuedMessageHeaders,
  getQueuedMessageHeader,
  hasReadableQueuedMessage,
  hasWaitingQueuedMessage,
  queuedMessageAwaitingReopen,
  queuedMessageHeaders,
  unsettledQueuedMessageBodyBytes
} from './queued-message-headers'
import { ensureQueuedMessagesTable } from './queued-message-schema'
import { createJournalReducerState } from './journal-reducer'
import { queuedMessageSettlementOwed } from './queued-message-settlement'
import {
  getQueuedMessage,
  insertQueuedMessage,
  listQueuedMessages,
  queuedMessagesSettledByOp,
  withdrawQueuedMessageInTransaction
} from './queued-message-table'
import { resumableQueuePause } from './queued-message-pause'

let db: Database.Database
const SESSION = 'plans'

beforeEach(() => {
  db = new Database(':memory:')
  ensureQueuedMessagesTable(db)
  insertQueuedMessage(db, {
    sessionId: SESSION,
    messageId: 'head',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'head' }] },
    fingerprint: 'fp',
    hostInstance: 'host',
    queuedAt: { epoch: 'epoch', sequence: 1 },
    now: 1
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  db.close()
})

function expectPlan(read: () => unknown, bindings: SqliteBindings, index: string) {
  const prepare = vi.spyOn(db, 'prepare')
  read()
  const sql = prepare.mock.calls[0]?.[0]
  prepare.mockRestore()
  if (!sql) {
    throw new Error('expected a prepared query')
  }
  const plan = db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...bindings)
    .map((row) => row.detail)
    .join('\n')
  expect(plan).toContain(index)
  expect(plan).not.toMatch(/SCAN queued_messages|USE TEMP B-TREE/)
  if (index === 'queued_messages_readable_unsettled_position') {
    expect(
      db
        .prepare(`EXPLAIN ${sql}`)
        .all(...bindings)
        .map((row) => row.p4)
        .join('\n')
    ).not.toMatch(/json_valid|instr\(|typeof\(/)
  }
}

it('keeps unsettled reads on the readable index and rare all-state reads on the position index', () => {
  for (const selection of ['all', 'waiting', 'unsettled'] as const) {
    expectPlan(
      () => [...queuedMessageHeaders(db, SESSION, selection)],
      [SESSION],
      selection === 'all'
        ? 'queued_messages_position'
        : 'queued_messages_readable_unsettled_position'
    )
  }
  expectPlan(
    () => hasWaitingQueuedMessage(db, SESSION),
    [SESSION],
    'queued_messages_readable_unsettled_position'
  )
  expectPlan(() => hasReadableQueuedMessage(db, SESSION), [SESSION], 'queued_messages_position')
  expectPlan(
    () => unsettledQueuedMessageBodyBytes(db, SESSION),
    [SESSION],
    'queued_messages_state_settled'
  )
  expectPlan(
    () => listQueuedMessages(db, SESSION),
    [SESSION],
    'queued_messages_readable_unsettled_position'
  )
})

it('keeps point, consume, retention, withdrawal and receipt queries indexed', () => {
  expectPlan(
    () => getQueuedMessageHeader(db, SESSION, 'head'),
    [SESSION, 'head'],
    'sqlite_autoindex_queued_messages_1'
  )
  expectPlan(
    () => getQueuedMessage(db, SESSION, 'head'),
    [SESSION, 'head'],
    'sqlite_autoindex_queued_messages_1'
  )
  expectPlan(
    () => queuedMessagesSettledByOp(db, SESSION, 'op'),
    [SESSION, 'op'],
    'queued_messages_position'
  )
  expectPlan(
    () =>
      withdrawQueuedMessageInTransaction(db, {
        sessionId: SESSION,
        messageId: 'head',
        settledByOp: 'op',
        now: 2
      }),
    [2, 'op', SESSION, 'head'],
    'sqlite_autoindex_queued_messages_1'
  )
  db.prepare("UPDATE queued_messages SET state = 'dispatched', consumed_as = 'handoff'").run()
  expectPlan(
    () => dispatchedQueuedMessageHeader(db, SESSION, 'handoff'),
    [SESSION, 'handoff'],
    'queued_messages_consumed_as'
  )
  expectPlan(
    () => [...expiredDispatchedQueuedMessageHeaders(db, SESSION, 3)],
    [SESSION, 3],
    'queued_messages_state_settled'
  )
})

it('never probes direct submissions for settlement or reopen', () => {
  db.prepare("UPDATE queued_messages SET state = 'withdrawn'").run()
  const state = createJournalReducerState(SESSION, 'epoch')
  for (const dispatchState of ['rejected', 'pending', 'unknown'] as const) {
    state.submissions.set(dispatchState, {
      clientMessageId: dispatchState,
      dispatchState,
      fence: 0,
      payloadFingerprint: 'fp',
      providerItemId: null,
      reason: null,
      submittedAt: 1,
      resolvedAt: null
    })
  }
  const prepare = vi.spyOn(db, 'prepare')
  expect(queuedMessageSettlementOwed(db, SESSION, state.submissions)).toBe(false)
  expect(prepare).not.toHaveBeenCalled()
  expect(queuedMessageAwaitingReopen(db, SESSION, state.submissions)).toBe(false)
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(prepare.mock.calls[0]?.[0]).not.toContain('consumed_as')
})

it('reads a consume link fresh after provisional state changes roll back', () => {
  db.prepare("UPDATE queued_messages SET state = 'returned', consumed_as = 'handoff'").run()
  const state = createJournalReducerState(SESSION, 'epoch')
  state.submissions.set('handoff', {
    clientMessageId: 'handoff',
    queuedMessageId: 'head',
    dispatchState: 'rejected',
    fence: 0,
    payloadFingerprint: 'fp',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  })
  expect(queuedMessageSettlementOwed(db, SESSION, state.submissions)).toBe(false)
  db.exec('BEGIN')
  try {
    db.prepare("UPDATE queued_messages SET state = 'dispatched'").run()
    expect(queuedMessageSettlementOwed(db, SESSION, state.submissions)).toBe(true)
  } finally {
    db.exec('ROLLBACK')
  }
  expect(queuedMessageSettlementOwed(db, SESSION, state.submissions)).toBe(false)
})

it('does not open the card iterator when there is no resumable pause', () => {
  const cards = {
    [Symbol.iterator]() {
      throw new Error('no pause can hold a card')
    }
  }
  expect(resumableQueuePause([], cards)).toBeNull()
})
