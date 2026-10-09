import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalMessageItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { agentSessionFailureFact } from '../../../shared/agent-session-failure'
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
import {
  deriveQueuePauses,
  nextSendableQueuedCard,
  resumableQueuePause
} from './queued-message-pause'
import { ensureQueuedMessagesTable } from './queued-message-schema'
import {
  insertQueuedMessage,
  listQueuedMessages,
  type QueuedMessageState
} from './queued-message-table'
import { createJournalReducerState } from './journal-reducer'
import { queuedMessageSettlementOwed, settleOwedQueuedMessages } from './queued-message-settlement'
import { pruneQueuedMessages } from './queued-message-retention'

const SESSION = 'queue-reads'
const EPOCH = 'epoch'
let db: Database.Database

function message(text: string): AgentJournalMessageItem {
  return { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
}

function insert(messageId: string, position?: number, body = message(messageId)) {
  return insertQueuedMessage(db, {
    sessionId: SESSION,
    messageId,
    position,
    body,
    fingerprint: `fp-${messageId}`,
    hostInstance: 'host',
    queuedAt: { epoch: EPOCH, sequence: 12 },
    now: 1
  })
}

function transition(
  messageId: string,
  state: QueuedMessageState,
  consumedAs: string | null = null,
  settledAt: number | null = null
) {
  db.prepare(
    'UPDATE queued_messages SET state = ?, consumed_as = ?, settled_at = ? WHERE message_id = ?'
  ).run(state, consumedAs, settledAt, messageId)
}

function submission(
  clientMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState']
): AgentJournalSubmission {
  return {
    clientMessageId,
    dispatchState,
    fence: 0,
    payloadFingerprint: 'fp',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
}

function seedTombstones() {
  db.prepare(
    `WITH RECURSIVE positions(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM positions WHERE n < 3000)
     INSERT INTO queued_messages
       (session_id, message_id, position, body_json, fingerprint, created_at, host_instance, state, settled_at)
     SELECT ?, 'tombstone-' || n, -n, ?, 'fp', 1, 'host', 'withdrawn', 900 FROM positions`
  ).run(SESSION, JSON.stringify(message('old text')))
}

function queryPlan(sql: string | undefined, bindings: SqliteBindings): string {
  if (!sql) {
    throw new Error('the query was not prepared')
  }
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...bindings)
    .map((row) => row.detail)
    .join('\n')
}

beforeEach(() => {
  db = new Database(':memory:')
  ensureQueuedMessagesTable(db)
})

afterEach(() => {
  vi.restoreAllMocks()
  db.close()
})

describe('body-free queue reads', () => {
  it('selects headers without body or rejection JSON, and never calls JSON.parse', () => {
    insert('head')
    insert('tail', undefined, message('a large body 💬'.repeat(1000)))
    transition('tail', 'returned', 'handoff')
    db.prepare('UPDATE queued_messages SET returned_rejection = ? WHERE message_id = ?').run(
      '{',
      'tail'
    )
    const prepare = vi.spyOn(db, 'prepare')
    const parse = vi.spyOn(JSON, 'parse')
    const headers = [...queuedMessageHeaders(db, SESSION, 'unsettled')]
    expect(headers.map((row) => row.messageId)).toEqual(['head', 'tail'])
    expect(headers.every((row) => !('body' in row) && !('returnedRejection' in row))).toBe(true)
    expect(getQueuedMessageHeader(db, SESSION, 'head')).toEqual(headers[0])
    expect(hasWaitingQueuedMessage(db, SESSION)).toBe(true)
    expect(hasReadableQueuedMessage(db, SESSION)).toBe(true)
    expect(parse).not.toHaveBeenCalled()
    for (const [sql] of prepare.mock.calls) {
      expect(sql.split('FROM')[0]).not.toMatch(/body_json|returned_rejection/)
    }
  })

  it.each(['waiting', 'returned'] as const)(
    'stops the next-card reader at a decisive %s head',
    (state) => {
      insert('head')
      insert('tail')
      transition('head', state)
      const visited: string[] = []
      function* counted() {
        for (const header of queuedMessageHeaders(db, SESSION, 'unsettled')) {
          visited.push(header.messageId)
          yield header
        }
      }
      expect(nextSendableQueuedCard([], counted())?.messageId ?? null).toBe(
        state === 'waiting' ? 'head' : null
      )
      expect(visited).toEqual(['head'])
      // Early return releases the SQLite reader before the next transaction.
      db.exec('BEGIN IMMEDIATE')
      db.exec('COMMIT')
    }
  )

  it('keeps SQL UTF-8 byte sums equal to JSON.stringify(body), including escaping and emoji', () => {
    const bodies = [
      message('é漢字🦦'),
      message('"quoted"\\path\n\t\u0000'),
      message('\ud800'),
      {
        ...message('blocks'),
        blocks: [
          { type: 'text' as const, text: '😀' },
          { type: 'text' as const, text: '\r\n' }
        ]
      }
    ]
    for (const [index, body] of bodies.entries()) {
      insert(`body-${index}`, undefined, body)
      expect(
        db
          .prepare('SELECT body_json FROM queued_messages WHERE message_id = ?')
          .get(`body-${index}`)?.body_json
      ).toBe(JSON.stringify(body))
    }
    transition('body-1', 'returned')
    insert('dispatched')
    transition('dispatched', 'dispatched', 'handoff', 1)
    insert('withdrawn')
    transition('withdrawn', 'withdrawn', null, 1)
    insert('corrupt')
    db.prepare('UPDATE queued_messages SET body_json = ? WHERE message_id = ?').run('{', 'corrupt')
    const expected = bodies.reduce(
      (bytes, body) => bytes + Buffer.byteLength(JSON.stringify(body), 'utf8'),
      0
    )
    const parse = vi.spyOn(JSON, 'parse')
    expect(unsettledQueuedMessageBodyBytes(db, SESSION)).toBe(expected)
    expect(unsettledQueuedMessageBodyBytes(db, 'other-session')).toBe(0)
    expect(parse).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'head', position: 0, hold: null, state: 'returned', body: '{' },
    { name: 'middle', position: 2, hold: null, state: 'returned', body: '{' },
    { name: 'cleared', position: 0, hold: null, state: 'waiting', body: '{' },
    { name: 'held', position: 0, hold: 'send_failed', state: 'waiting', body: '{' },
    { name: 'unknown state', position: 0, hold: null, state: 'future', body: '{}' }
  ])('an unreadable $name row is never shown, selected, or a pause/reopen obligation', (bad) => {
    insert('first', 1)
    insert('last', 3)
    insert('bad', bad.position)
    db.prepare(
      `UPDATE queued_messages SET body_json = ?, state = ?, hold_reason = ?, queued_sequence = 0
       WHERE message_id = 'bad'`
    ).run(bad.body, bad.state, bad.hold)
    const state = createJournalReducerState(SESSION, EPOCH)
    state.queuePauseMarks.reopenedSequence = 5
    state.queuePauseMarks.cleared = { sequence: 4, operationId: 'clear', messageIds: ['bad'] }
    const cards = [...queuedMessageHeaders(db, SESSION, 'unsettled')]
    const pauses = deriveQueuePauses({
      epoch: EPOCH,
      marks: state.queuePauseMarks,
      latestAcceptedTurnSequence: 0,
      cards: queuedMessageHeaders(db, SESSION, 'waiting'),
      reopenFloor: null
    })
    expect(cards.map((row) => row.messageId)).toEqual(['first', 'last'])
    expect(listQueuedMessages(db, SESSION).map((row) => row.messageId)).toEqual(['first', 'last'])
    expect(pauses).toEqual([])
    expect(nextSendableQueuedCard(pauses, cards)?.messageId).toBe('first')
    db.prepare("DELETE FROM queued_messages WHERE message_id != 'bad'").run()
    expect(hasWaitingQueuedMessage(db, SESSION)).toBe(false)
    expect(queuedMessageAwaitingReopen(db, SESSION, state.submissions)).toBe(false)
    expect(getQueuedMessageHeader(db, SESSION, 'bad')).toBeNull()
  })

  it('preserves FIFO and pause decisions over a mixed queue using only headers', () => {
    insert('held')
    insert('before-stop')
    insert('returned')
    insert('carried')
    insert('after-reopen')
    insert('dispatched')
    transition('returned', 'returned')
    transition('dispatched', 'dispatched', 'handoff', 1)
    db.prepare(
      "UPDATE queued_messages SET hold_reason = 'send_failed' WHERE message_id = 'held'"
    ).run()
    db.prepare(
      "UPDATE queued_messages SET queued_sequence = 2 WHERE message_id = 'before-stop'"
    ).run()
    const state = createJournalReducerState(SESSION, EPOCH)
    state.queuePauseMarks.latestStop = { sequence: 5, event: { reason: 'user-stop', at: 1 } }
    state.queuePauseMarks.cleared = { sequence: 6, operationId: 'clear', messageIds: ['carried'] }
    state.queuePauseMarks.reopenedSequence = 8
    const input = {
      epoch: EPOCH,
      marks: state.queuePauseMarks,
      latestAcceptedTurnSequence: 0,
      reopenFloor: null
    }
    const bodies = listQueuedMessages(db, SESSION)
    const fromBodies = deriveQueuePauses({ ...input, cards: bodies })
    const fromHeaders = deriveQueuePauses({
      ...input,
      cards: queuedMessageHeaders(db, SESSION, 'waiting')
    })
    expect(fromHeaders.map((pause) => pause.reason)).toEqual(['stopped', 'cleared', 'restarted'])
    expect(fromHeaders).toEqual(fromBodies)
    expect(
      nextSendableQueuedCard(fromHeaders, queuedMessageHeaders(db, SESSION, 'unsettled'))
    ).toBeNull()
    expect(
      resumableQueuePause(fromHeaders, queuedMessageHeaders(db, SESSION, 'unsettled'))?.reason
    ).toBe('stopped')
    expect(
      nextSendableQueuedCard([], queuedMessageHeaders(db, SESSION, 'unsettled'))?.messageId
    ).toBe('before-stop')
    transition('before-stop', 'withdrawn', null, 1)
    expect(nextSendableQueuedCard([], queuedMessageHeaders(db, SESSION, 'unsettled'))).toBeNull()
    transition('returned', 'withdrawn', null, 1)
    expect(
      nextSendableQueuedCard([], queuedMessageHeaders(db, SESSION, 'unsettled'))?.messageId
    ).toBe('carried')
  })

  it('stops pause derivation once every cleared card and the pre-reopen card are found', () => {
    const first = insert('cleared-1')
    const second = insert('cleared-2')
    const state = createJournalReducerState(SESSION, EPOCH)
    state.queuePauseMarks.reopenedSequence = 20
    state.queuePauseMarks.cleared = {
      sequence: 19,
      operationId: 'clear',
      messageIds: ['cleared-1', 'cleared-2']
    }
    function* cards() {
      yield first
      yield second
      throw new Error('the rest of the queue must not be read')
    }
    expect(
      deriveQueuePauses({
        epoch: EPOCH,
        marks: state.queuePauseMarks,
        latestAcceptedTurnSequence: 0,
        cards: cards(),
        reopenFloor: null
      })
    ).toEqual([
      {
        reason: 'cleared',
        since: { epoch: EPOCH, sequence: 19 },
        messageIds: ['cleared-1', 'cleared-2']
      },
      { reason: 'restarted', since: { epoch: EPOCH, sequence: 20 } }
    ])
  })
})

describe('indexed bookkeeping', () => {
  it('settles only the rejected current consume links among thousands of tombstones', () => {
    seedTombstones()
    insert('owed')
    transition('owed', 'dispatched', 'rejected', 1)
    insert('accepted')
    transition('accepted', 'dispatched', 'accepted', 1)
    insert('corrupt')
    transition('corrupt', 'dispatched', 'corrupt-ref', 1)
    db.prepare("UPDATE queued_messages SET body_json = '{' WHERE message_id = 'corrupt'").run()
    const state = createJournalReducerState(SESSION, EPOCH)
    state.submissions.set('rejected', {
      ...submission('rejected', 'rejected'),
      queuedMessageId: 'owed',
      rejection: agentSessionFailureFact('providerRejected')
    })
    state.submissions.set('accepted', submission('accepted', 'accepted'))
    state.submissions.set('corrupt-ref', {
      ...submission('corrupt-ref', 'rejected'),
      queuedMessageId: 'corrupt'
    })
    const prepare = vi.spyOn(db, 'prepare')
    const parse = vi.spyOn(JSON, 'parse')
    expect(queuedMessageSettlementOwed(db, SESSION, state.submissions)).toBe(true)
    expect(settleOwedQueuedMessages(db, { sessionId: SESSION, state, now: 10 })).toBe(1)
    expect(queuedMessageSettlementOwed(db, SESSION, state.submissions)).toBe(false)
    expect(parse).not.toHaveBeenCalled()
    expect(
      prepare.mock.calls
        .filter(([sql]) => sql.startsWith('SELECT'))
        .every(([sql]) => sql.includes('consumed_as = ?'))
    ).toBe(true)
    expect(getQueuedMessageHeader(db, SESSION, 'owed')?.state).toBe('returned')
  })

  it('asks retention verdicts only for expired dispatched rows and keeps pending/refused ones', () => {
    seedTombstones()
    for (const id of [
      'accepted',
      'pending',
      'rejected',
      'absent',
      'fresh',
      'corrupt',
      'same-time'
    ]) {
      insert(id)
      transition(id, 'dispatched', `ref-${id}`, id === 'fresh' ? 901 : 1)
    }
    db.prepare("UPDATE queued_messages SET body_json = '{' WHERE message_id = 'corrupt'").run()
    const verdict = vi.fn((ref: string) => {
      if (ref === 'ref-pending') {
        return 'pending' as const
      }
      if (ref === 'ref-rejected') {
        return 'rejected' as const
      }
      return 'terminal-not-refused' as const
    })
    const prepare = vi.spyOn(db, 'prepare')
    const parse = vi.spyOn(JSON, 'parse')
    expect(
      pruneQueuedMessages(db, {
        sessionId: SESSION,
        now: 1000,
        replayWindowMs: 100,
        submissionVerdict: verdict
      })
    ).toBe(3)
    expect(verdict.mock.calls.map(([ref]) => ref)).toEqual([
      'ref-absent',
      'ref-accepted',
      'ref-pending',
      'ref-rejected',
      'ref-same-time'
    ])
    expect(parse).not.toHaveBeenCalled()
    for (const [sql] of prepare.mock.calls.filter(([sql]) => sql.startsWith('SELECT'))) {
      expect(sql).toContain("state = 'dispatched' AND settled_at < ?")
      expect(sql).toContain('LIMIT 1')
      expect(sql.split('FROM')[0]).not.toContain('body_json')
    }
    expect(
      [...expiredDispatchedQueuedMessageHeaders(db, SESSION, 900)].map((row) => row.messageId)
    ).toEqual(['pending', 'rejected'])
  })

  it('creates downgrade-safe indexes idempotently and uses them for the matching queries', () => {
    ensureQueuedMessagesTable(db)
    seedTombstones()
    insert('waiting')
    insert('dispatched')
    transition('dispatched', 'dispatched', 'handoff', 1)
    const prepare = vi.spyOn(db, 'prepare')
    nextSendableQueuedCard([], queuedMessageHeaders(db, SESSION, 'unsettled'))
    dispatchedQueuedMessageHeader(db, SESSION, 'handoff')
    const expired = expiredDispatchedQueuedMessageHeaders(db, SESSION, 900)
    const expiredRows = [...expired]
    expect(expiredRows).toHaveLength(1)
    hasWaitingQueuedMessage(db, SESSION)
    const queries = prepare.mock.calls.map(([sql]) => sql)
    prepare.mockRestore()
    expect(queryPlan(queries[0], [SESSION])).toContain(
      'queued_messages_readable_unsettled_position'
    )
    expect(queryPlan(queries[1], [SESSION, 'handoff'])).toContain('queued_messages_consumed_as')
    expect(queryPlan(queries[2], [SESSION, 900])).toContain('queued_messages_state_settled')
    expect(queryPlan(queries[3], [SESSION, 900, 1, 'dispatched'])).toContain(
      'queued_messages_state_settled'
    )
    expect(queryPlan(queries[4], [SESSION])).toContain(
      'queued_messages_readable_unsettled_position'
    )
    expect(
      queryPlan('SELECT MAX(position) FROM queued_messages WHERE session_id = ?', [SESSION])
    ).toContain('queued_messages_position')
    expect(db.pragma('user_version', { simple: true })).toBe(0)
  })
})
