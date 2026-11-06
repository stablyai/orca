import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import type { JournalHostDatabase } from './journal-host-database'
import { restoreJournal } from './journal-open'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlReducer } from './journal-sql-reducer'
import { exportJournalControlState } from './journal-sql-control-export'
import { convertJournalSqlProjection } from './journal-sql-conversion'
import { journalSqlProjectionSchema } from './journal-sql-projection-schema'
import { journalSqlControlSnapshot } from './journal-sql-control-export.test-fixture'
import { publishJournalOutcomeEpoch } from './journal-outcome-write'
import { persistJournalOutcomeRows, persistJournalOutcomeTransition } from './journal-outcome-table'
import { journalOutcomeSource } from './journal-outcome-format'
import { journalSqlLifecycleRows } from './journal-sql-reducer-rows.test-fixture'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import { memoryJournalMap } from './journal-memory-collections'
import { journalInputOrder } from './journal-input-order'
import { encodeJournalState } from './journal-state-codec'

let root: string
let database: JournalHostDatabase
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-conversion-admission-'))
  database = openTestJournalHostDatabase(root)
})
afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it('skips superseded unreadable records and future keys while preserving newest deletions', () => {
  database.transaction((db) => {
    publishTestJournalEpoch(db, 'session', 'epoch')
    publishJournalOutcomeEpoch(db, 'session', 'epoch', journalSqlLifecycleRows())
    const source = journalOutcomeSource(db, 'session', 'epoch')!
    const insert = db.prepare(`INSERT INTO journal_outcomes
      VALUES (?,?,'items',?,99,'s0000000000000001:0000000000000000','{}',0)`)
    insert.run(source.generation, 1, '"turn"')
    insert.run(source.generation, source.through + 1, '"future"')
  })
  const oracle = restoreJournal(database.db, 'session')!
  const selected = restoreJournal(database.db, 'session', { selection: 'recursive' })!
  expect(selected).toMatchObject({ newer: null, damage: null })
  expect(selected.state.items.get('assistant')).toBeUndefined()
  expect(selected.state.items.get('turn')?.revision).toBe(1)
  expect(encodeJournalState(selected.state)).toEqual(encodeJournalState(oracle.state))
  database.db.exec('UPDATE journal_outcome_epochs SET through_seq=through_seq+1')
  expect(restoreJournal(database.db, 'session', { selection: 'recursive' })).toMatchObject({
    newer: { sequence: 1 },
    damage: null
  })
  // A refused iterator releases its cursor before recovery or the next open accesses the file.
  database.db.exec(`UPDATE journal_outcomes SET format=2 WHERE entry_key='"future"'`)
  expect(restoreJournal(database.db, 'session', { selection: 'recursive' })).toMatchObject({
    newer: null,
    damage: { sequence: 1, cause: 'unparseable-row' }
  })
})

it.each([
  { name: 'lifecycle', rows: journalSqlLifecycleRows() },
  { name: 'native retry', rows: journalSqlRetryRows(false) },
  { name: 'legacy retry', rows: journalSqlRetryRows(true) }
])('converts actual outcome restore and continues its next command: $name', ({ rows }) => {
  const head = rows.slice(0, -1)
  const last = rows.at(-1)!
  database.transaction((db) => {
    publishTestJournalEpoch(db, 'session', 'epoch')
    publishJournalOutcomeEpoch(db, 'session', 'epoch', head)
  })
  const ordinary = restoreJournal(database.db, 'session')!
  database.transaction((db) => convertJournalSqlProjection(db, 'session'))
  const reducer = () =>
    new JournalSqlReducer(new JournalSqlScope(database.db, 'session', 'epoch'), 'epoch')
  expect(journalSqlControlSnapshot(reducer().state)).toEqual(
    journalSqlControlSnapshot(ordinary.state)
  )
  for (const [key, value] of memoryJournalMap(ordinary.state.items)) {
    expect(reducer().state.items.get(key)).toEqual(value)
  }
  const source = journalOutcomeSource(database.db, 'session', 'epoch')!
  database.db
    .prepare(`INSERT INTO journal_outcomes SELECT 1000,seq,field,entry_key,format,ordinal,value_json,deleted
    FROM journal_outcomes WHERE generation=?`)
    .run(source.generation)
  const finish = (state: typeof ordinary.state) => journalInputOrder(state).cards.ensure(state)
  const expected = persistJournalOutcomeRows(
    database.db,
    ordinary.state,
    { ...source, generation: 1000 },
    [last],
    100,
    false,
    finish
  )
  persistJournalOutcomeTransition(
    database.db,
    reducer().transition(),
    source,
    [last],
    100,
    false,
    finish
  )
  const records = (generation: number) =>
    database.db
      .prepare(`SELECT field,entry_key,format,ordinal,value_json,deleted
    FROM journal_outcomes WHERE generation=? AND seq=? ORDER BY field,entry_key`)
      .all(generation, last.seq)
  expect(records(source.generation)).toEqual(records(1000))
  expect(journalSqlControlSnapshot(reducer().state)).toEqual(
    journalSqlControlSnapshot(expected.adopt())
  )
})

it('preserves item and nested aliases across export, replacement, deletion and rollback', () => {
  const rows = journalSqlLifecycleRows().slice(0, 8)
  database.transaction((db) => {
    publishTestJournalEpoch(db, 'session', 'epoch')
    publishJournalOutcomeEpoch(db, 'session', 'epoch', rows)
  })
  const loaded = restoreJournal(database.db, 'session')!
  const item = [...memoryJournalMap(loaded.state.items).values()].find(
    (value) => value.body.kind === 'message'
  )!
  loaded.state.itemEchoes.set('shared', { item, body: item.body })
  database.db.exec(journalSqlProjectionSchema())
  const exported = new JournalSqlReducer(
    new JournalSqlScope(database.db, 'session', 'exported'),
    'epoch'
  )
  exported.context.bulkLoad(() => {
    exportJournalControlState(loaded.state, exported.state, { items: true })
    exported.flush()
  })
  const reducer = () =>
    new JournalSqlReducer(new JournalSqlScope(database.db, 'session', 'exported'), 'epoch')
  const alias = (command: JournalSqlReducer) =>
    z
      .custom<{ item: AgentJournalRenderItem; body: AgentJournalRenderItem['body'] }>()
      .parse(command.state.itemEchoes.get('shared'))
  let command = reducer()
  expect(alias(command).item).toBe(command.state.items.get(item.itemId))
  expect(alias(command).body).toBe(command.state.items.get(item.itemId)?.body)
  alias(command).item.observedAt = 222
  command.flush()
  command = reducer()
  expect(command.state.items.get(item.itemId)?.observedAt).toBe(222)
  database.db.exec('SAVEPOINT alias_rollback')
  alias(command).item.observedAt = 999
  command.flush()
  database.db.exec('ROLLBACK TO alias_rollback; RELEASE alias_rollback')
  command = reducer()
  expect(alias(command).item.observedAt).toBe(222)
  command.state.items.set(item.itemId, {
    ...command.state.items.get(item.itemId)!,
    observedAt: 333
  })
  command.flush()
  command = reducer()
  expect(command.state.items.get(item.itemId)?.observedAt).toBe(333)
  expect(alias(command).item.observedAt).toBe(222)
  command.state.items.delete(item.itemId)
  command.flush()
  command = reducer()
  expect(command.state.items.has(item.itemId)).toBe(false)
  expect(alias(command).item.observedAt).toBe(222)
})
