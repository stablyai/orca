import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  applyJournalRow,
  createJournalReducerState,
  type JournalReducerState
} from './projection/journal-reducer'
import { journalOutcomeScalars } from './outcomes/journal-outcome-codec'
import { ensureJournalOutcomeTables } from './outcomes/journal-outcome-format'
import { journalSqlProjectionSchema } from './journal-sql-projection-schema'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { journalInputOrder } from './input-order/journal-input-order'
import { journalOutcomeScalarJson } from './journal-outcome-scalars'
import {
  persistJournalOutcomeRows,
  persistJournalOutcomeTransition
} from './outcomes/journal-outcome-table'
import { journalSqlLifecycleRows } from './journal-sql-reducer-rows.test-fixture'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import { memoryJournalMap } from './journal-memory-collections'
import { journalInputPresentationMember } from './input-order/journal-input-obligations'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function answers(state: JournalReducerState) {
  const order = journalInputOrder(state)
  order.cards.ensure(state)
  return {
    firstQueued: order.firstQueued()?.clientMessageId,
    explicit: order.explicitSend()?.clientMessageId,
    entered: [...order.enteredSubmissions()].map((send) => send.clientMessageId),
    unsettled: order.unsettledSubmissions().map((send) => send.clientMessageId),
    sending: order.sendingSubmissions().map((send) => send.clientMessageId),
    stopped: order.stoppedHistoryInputs('send').map((send) => send.clientMessageId),
    inputs: ['send', 'second', 'first', 'retry'].map((id) => ({
      id,
      predecessors: order.predecessors(state, id),
      original: order.familyOriginal(id)?.clientMessageId,
      linked: [...order.linkedTo(id)].map((send) => send.clientMessageId),
      ended: state.inputs.ended.has(id)
    })),
    cards: ['q', 'command', 'ordinary', 'foreign'].map((id) => {
      const card = state.queue.cards.get(id)
      return [id, card ? order.paused(state, card, null) : null]
    }),
    head: order.head(state, null)?.messageId ?? null,
    bounds: order.cardBounds(state),
    newest: state.queries.newestTurnBySequence(state),
    clear: state.queries.latestContextClearSequence(state),
    echo: state.queries.echoClaimant(state, 'fp', false),
    unopened: state.queries.latestAcceptedUnopened(state),
    candidates: state.queries.candidatesForFence(state, 1).map((send) => send.clientMessageId),
    handovers: [...state.queries.candidatesForHandoverFence(state, 1)].map(
      (send) => send.clientMessageId
    ),
    returned: [...state.queries.returnedCommandIds(state)],
    secondEnded: state.inputs.ended.has('second'),
    newestFailure: order.newestTurn.failure()
  }
}

it.each([
  { name: 'lifecycle and rollback', rows: journalSqlLifecycleRows() },
  { name: 'native queue and retry families', rows: journalSqlRetryRows(false) },
  { name: 'legacy queue and retry families', rows: journalSqlRetryRows(true) }
])('matches stored bytes, key order and next actions for $name', ({ rows }) => {
  const db = new Database(':memory:')
  databases.push(db)
  db.exec(journalSqlProjectionSchema())
  ensureJournalOutcomeTables(db)
  const oracle = new Database(':memory:')
  databases.push(oracle)
  ensureJournalOutcomeTables(oracle)
  let memory = createJournalReducerState('session', 'epoch')
  for (const row of rows) {
    db.exec('SAVEPOINT command')
    const sql = new JournalSqlReducer(new JournalSqlScope(db, 'session', 'generation'), 'epoch')
    const source = { generation: 1, prefix: 0 }
    const finish = (state: JournalReducerState) => journalInputOrder(state).cards.ensure(state)
    const transition = persistJournalOutcomeRows(
      oracle,
      memory,
      source,
      [row],
      row.ts,
      false,
      finish
    )
    persistJournalOutcomeTransition(db, sql.transition(), source, [row], row.ts, false, finish)
    expect(answers(sql.state), `answers after ${row.seq}`).toEqual(answers(transition.state))
    const records = (database: Database.Database) =>
      database
        .prepare(`SELECT seq, field, entry_key, format, ordinal, value_json, deleted
        FROM journal_outcomes WHERE seq=? ORDER BY field, entry_key`)
        .all(row.seq)
    expect(records(db), `stored bytes and ordinals after ${row.seq}`).toEqual(records(oracle))
    expect(
      db
        .prepare(`SELECT entry_key FROM journal_proj_items
      WHERE hidden=0 ORDER BY ordinal`)
        .all()
        .map((row) => JSON.parse(String(row.entry_key)))
    ).toEqual(
      [...memoryJournalMap(transition.state.items).keys()].filter((key) =>
        journalInputPresentationMember(transition.state, key)
      )
    )
    db.exec('RELEASE command')
    memory = transition.adopt()
    const loaded = new JournalSqlReducer(new JournalSqlScope(db, 'session', 'generation'), 'epoch')
    expect(answers(loaded.state), `recreated shell after ${row.seq}`).toEqual(answers(memory))
    if (row.kind === 'item' && row.itemId === 'second-turn') {
      expect(loaded.state.inputs.ended.has('second')).toBe(true)
    }
    expect(
      Object.fromEntries(
        Object.entries(journalOutcomeScalars(loaded.state)).map(([key, value]) => [
          key,
          journalOutcomeScalarJson(value)
        ])
      )
    ).toEqual(
      Object.fromEntries(
        Object.entries(journalOutcomeScalars(memory)).map(([key, value]) => [
          key,
          journalOutcomeScalarJson(value)
        ])
      )
    )
    db.exec('SAVEPOINT aborted')
    const aborted = new JournalSqlReducer(new JournalSqlScope(db, 'session', 'generation'), 'epoch')
    applyJournalRow(
      aborted.state,
      aborted.context.input({
        v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
        epoch: 'epoch',
        seq: row.seq + 1,
        ts: 200,
        fence: 2,
        kind: 'item',
        itemId: 'aborted',
        revision: 0,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'must disappear' }]
        }
      })
    )
    aborted.flush()
    db.exec('ROLLBACK TO aborted; RELEASE aborted')
    const rolledBack = new JournalSqlReducer(
      new JournalSqlScope(db, 'session', 'generation'),
      'epoch'
    )
    expect(rolledBack.state.items.has('aborted')).toBe(false)
    expect(rolledBack.state.lastSequence).toBe(row.seq)
    expect(answers(rolledBack.state), `rollback after ${row.seq}`).toEqual(answers(memory))
  }
})

it.each([
  journalSqlLifecycleRows,
  () => journalSqlRetryRows(false),
  () => journalSqlRetryRows(true)
])('preserves per-row saved ordering when several rows share one command context', (rows) => {
  const sqlDb = new Database(':memory:')
  const memoryDb = new Database(':memory:')
  databases.push(sqlDb, memoryDb)
  sqlDb.exec(journalSqlProjectionSchema())
  ensureJournalOutcomeTables(sqlDb)
  ensureJournalOutcomeTables(memoryDb)
  const source = { generation: 1, prefix: 0 }
  const state = createJournalReducerState('session', 'epoch')
  const sql = new JournalSqlReducer(new JournalSqlScope(sqlDb, 'session', 'generation'), 'epoch')
  const finish = (state: JournalReducerState) => journalInputOrder(state).cards.ensure(state)
  const input = rows()
  const expected = persistJournalOutcomeRows(memoryDb, state, source, input, 100, false, finish)
  persistJournalOutcomeTransition(sqlDb, sql.transition(), source, input, 100, false, finish)
  const records = (db: Database.Database) =>
    db
      .prepare(`SELECT seq, field, entry_key,
      format, ordinal, value_json, deleted FROM journal_outcomes ORDER BY seq, field, entry_key`)
      .all()
  expect(records(sqlDb)).toEqual(records(memoryDb))
  const loaded = new JournalSqlReducer(new JournalSqlScope(sqlDb, 'session', 'generation'), 'epoch')
  expect(answers(loaded.state)).toEqual(answers(expected.state))
})
