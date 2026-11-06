import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import { ensureJournalOutcomeTables } from './journal-outcome-format'
import { journalSqlProjectionSchema } from './journal-sql-projection-schema'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { journalInputOrder } from './journal-input-order'
import { persistJournalOutcomeRows, persistJournalOutcomeTransition } from './journal-outcome-table'
import { journalSqlLifecycleRows } from './journal-sql-reducer-rows.test-fixture'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import { exportJournalControlState } from './journal-sql-control-export'
import { journalOutcomeScalars } from './journal-outcome-codec'
import { journalOutcomeScalarJson } from './journal-outcome-scalars'
import type { JournalRow } from './journal-row-schema'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function snapshot(state: JournalReducerState) {
  const order = journalInputOrder(state)
  order.cards.ensure(state)
  return {
    scalars: Object.fromEntries(
      Object.entries(journalOutcomeScalars(state)).map(([key, value]) => [
        key,
        journalOutcomeScalarJson(value)
      ])
    ),
    firstQueued: order.firstQueued()?.clientMessageId,
    explicit: order.explicitSend()?.clientMessageId,
    entered: [...order.enteredSubmissions()].map((send) => send.clientMessageId),
    unsettled: order.unsettledSubmissions().map((send) => send.clientMessageId),
    sending: order.sendingSubmissions().map((send) => send.clientMessageId),
    inputs: ['send', 'second', 'first', 'retry'].map((id) => ({
      id,
      predecessors: order.predecessors(state, id),
      original: order.familyOriginal(id)?.clientMessageId,
      linked: [...order.linkedTo(id)].map((send) => send.clientMessageId),
      ended: state.inputs.ended.has(id),
      submission: state.submissions.get(id),
      receipt: state.receipts.get(id)
    })),
    cards: ['q', 'command', 'ordinary', 'foreign'].map((id) => {
      const card = state.queue.cards.get(id)
      return [id, card, card ? order.paused(state, card, null) : null]
    }),
    head: order.head(state, null)?.messageId ?? null,
    bounds: order.cardBounds(state),
    newest: state.queries.newestTurnBySequence(state),
    candidates: state.queries.candidatesForFence(state, 1).map((send) => send.clientMessageId),
    returned: [...state.queries.returnedCommandIds(state)],
    newestFailure: order.newestTurn.failure()
  }
}

it.each([
  { name: 'lifecycle and rollback', rows: journalSqlLifecycleRows() },
  { name: 'native queue and retry families', rows: journalSqlRetryRows(false) },
  { name: 'legacy queue and retry families', rows: journalSqlRetryRows(true) }
])(
  'exports a restored chat so the SQL generation answers and continues as it does: $name',
  ({ rows }) => {
    const db = new Database(':memory:')
    const oracle = new Database(':memory:')
    databases.push(db, oracle)
    db.exec(journalSqlProjectionSchema())
    ensureJournalOutcomeTables(db)
    ensureJournalOutcomeTables(oracle)
    const source = { generation: 1, prefix: 0 }
    const finish = (state: JournalReducerState) => journalInputOrder(state).cards.ensure(state)
    const [last, ...head] = [rows.at(-1)!, ...rows.slice(0, -1)]
    let memory = createJournalReducerState('session', 'epoch')
    memory = persistJournalOutcomeRows(oracle, memory, source, head, 100, false, finish).adopt()
    // Ground truth: the same rows folded by the writer's own SQL shells.
    persistJournalOutcomeTransition(
      db,
      new JournalSqlReducer(new JournalSqlScope(db, 'session', 'built'), 'epoch').transition(),
      { generation: 2, prefix: 0 },
      head,
      100,
      false,
      finish
    )
    const exported = new JournalSqlReducer(new JournalSqlScope(db, 'session', 'exported'), 'epoch')
    exported.context.bulkLoad(() => {
      exportJournalControlState(memory, exported.state, { items: true })
      exported.flush()
    })
    const reload = (generation: string) =>
      new JournalSqlReducer(new JournalSqlScope(db, 'session', generation), 'epoch').state
    expect(snapshot(reload('exported'))).toEqual(snapshot(reload('built')))
    expect(snapshot(reload('exported'))).toEqual(snapshot(memory))
    // The next write over the exported generation saves what the memory fold saves.
    const next = (generation: string, outcome: number, row: JournalRow) =>
      persistJournalOutcomeTransition(
        db,
        new JournalSqlReducer(new JournalSqlScope(db, 'session', generation), 'epoch').transition(),
        { generation: outcome, prefix: 0 },
        [row],
        100,
        false,
        finish
      )
    next('built', 2, last)
    // The exported generation's writes extend the same saved history the memory fold read.
    const copy = db.prepare(`INSERT INTO journal_outcomes
      (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
      VALUES (3, ?, ?, ?, ?, ?, ?, ?)`)
    for (const record of oracle
      .prepare('SELECT * FROM journal_outcomes WHERE generation=1')
      .all()) {
      copy.run(
        record.seq,
        record.field,
        record.entry_key,
        record.format,
        record.ordinal,
        record.value_json,
        record.deleted
      )
    }
    next('exported', 3, last)
    const expected = persistJournalOutcomeRows(oracle, memory, source, [last], 100, false, finish)
    const records = (database: Database.Database, generation: number) =>
      database
        .prepare(`SELECT field, entry_key, format, ordinal, value_json, deleted
        FROM journal_outcomes WHERE generation=? AND seq=? ORDER BY field, entry_key`)
        .all(generation, last.seq)
    expect(records(db, 3)).toEqual(records(oracle, 1))
    expect(snapshot(reload('exported'))).toEqual(snapshot(expected.adopt()))
  }
)
