import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import {
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './store-lifecycle/journal-host-database-test-support'
import type { JournalHostDatabase } from './database/journal-host-database'
import { publishJournalOutcomeEpoch } from './outcomes/journal-outcome-write'
import { restoreJournal } from './replay/journal-open'
import { memoryJournalMap } from './journal-memory-collections'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { currentJournalSqlEpoch } from './journal-sql-meta'
import {
  convertJournalSqlProjection,
  finishJournalSqlConversion,
  prepareJournalSqlConversion
} from './journal-sql-conversion'
import { sweepJournalSqlProjectionPage } from './journal-sql-projection-sweep'
import { journalSqlProjectionSchema } from './journal-sql-projection-schema'
import { journalSqlControlSnapshot } from './journal-sql-control-export.test-fixture'
import { journalSqlLifecycleRows } from './journal-sql-reducer-rows.test-fixture'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'
import { insertJournalRow } from './durable-rows/journal-row-table'
import type { JournalRow } from './durable-rows/journal-row-schema'
import { applyJournalRow } from './projection/journal-reducer'
import { journalInputOrder } from './input-order/journal-input-order'

function admissionRows(legacy: boolean): JournalRow[] {
  const rows = journalSqlRetryRows(true)
  const epoch = rows[0]!
  const queue = rows.find((row) => row.kind === 'queue')!
  const send = rows.find((row) => row.kind === 'submission')!
  if (queue.change.op !== 'queued') {
    throw new Error('expected queued fixture')
  }
  const submission = { ...send, queuedMessageId: undefined }
  return [
    epoch,
    { ...queue, seq: 2 },
    {
      ...submission,
      seq: 3,
      clientMessageId: 'old',
      ...(legacy
        ? {
            inputOrderContext: { source: { epoch: 'prior', sequence: 7 }, basis: 'legacy', cut: 3 }
          }
        : {})
    },
    {
      ...queue,
      seq: 4,
      messageId: 'finished',
      change: { ...queue.change, op: 'queued', position: 10 }
    },
    { ...send, seq: 5, clientMessageId: 'finished-send', queuedMessageId: 'finished' },
    {
      v: epoch.v,
      epoch: 'epoch',
      ts: 100,
      fence: 1,
      seq: 6,
      kind: 'dispatch',
      clientMessageId: 'finished-send',
      state: 'accepted',
      providerItemId: 'provider',
      reason: null
    },
    {
      ...submission,
      seq: 7,
      clientMessageId: 'native',
      inputOrderContext: { source: { epoch: 'epoch', sequence: 7 }, basis: 'observed', cut: 7 }
    }
  ]
}

let root: string
let database: JournalHostDatabase
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-conversion-'))
  database = openTestJournalHostDatabase(root)
})
afterEach(async () => {
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

it.each([false, true])(
  'normalizes raw admissions and releases finished cards (legacy=%s)',
  (legacy) => {
    const rows = admissionRows(legacy)
    database.transaction((db) => {
      publishTestJournalEpoch(db, 'session', 'epoch')
      for (const row of rows) {
        insertJournalRow(db, 'session', row)
      }
    })
    const saved = () => database.db.prepare('SELECT * FROM journal_rows ORDER BY seq').all()
    const before = saved()
    database.transaction((db) => convertJournalSqlProjection(db, 'session'))
    expect(saved()).toEqual(before)
    const reducer = new JournalSqlReducer(
      new JournalSqlScope(database.db, 'session', 'epoch'),
      'epoch'
    )
    const state = reducer.state
    expect(state.inputEntries.get('old')).toEqual({
      context: {
        source: legacy ? { epoch: 'prior', sequence: 7 } : { epoch: 'epoch', sequence: 3 },
        basis: 'observed',
        cut: 3
      },
      witnessCardId: 'command'
    })
    expect(state.inputEntries.get('native')).toEqual({
      context: { source: { epoch: 'epoch', sequence: 7 }, basis: 'observed', cut: 7 },
      witnessCardId: 'command'
    })
    expect(journalInputOrder(state).firstQueued()?.clientMessageId).toBe('old')
    expect(journalInputOrder(state).predecessors(state, 'native').position).toBe(10)
    applyJournalRow(state, {
      v: rows[0]!.v,
      epoch: 'epoch',
      ts: 100,
      fence: 1,
      kind: 'tombstone',
      seq: 8,
      itemId: 'reopen',
      revision: 1,
      queueReopen: true
    })
    expect(journalInputOrder(state).predecessors(state, 'native').position).toBe(1)
    reducer.flush()
    const reopened = new JournalSqlReducer(
      new JournalSqlScope(database.db, 'session', 'epoch'),
      'epoch'
    )
    expect(journalInputOrder(reopened.state).firstQueued()?.clientMessageId).toBe('old')
    expect(journalInputOrder(reopened.state).predecessors(reopened.state, 'native').position).toBe(
      1
    )
  }
)

it.each([1, 2])(
  'normalizes materialized format-%s admissions without rewriting saved outcomes',
  (format) => {
    database.transaction((db) => {
      publishTestJournalEpoch(db, 'session', 'epoch')
      publishJournalOutcomeEpoch(db, 'session', 'epoch', admissionRows(false))
      if (format === 1) {
        db.prepare(
          "DELETE FROM journal_outcomes WHERE field IN ('inputEntries', 'inputCards')"
        ).run()
        db.prepare('UPDATE journal_outcomes SET format=1').run()
        db.prepare('UPDATE journal_outcome_epochs SET format=1').run()
      } else {
        db.prepare(
          `UPDATE journal_outcomes SET value_json=? WHERE field='inputEntries' AND entry_key=?`
        ).run(
          JSON.stringify([
            'old',
            {
              context: { source: { epoch: 'prior', sequence: 7 }, basis: 'legacy', cut: 3 },
              witnessCardId: 'command'
            }
          ]),
          JSON.stringify('old')
        )
      }
    })
    const saved = () =>
      database.db.prepare('SELECT * FROM journal_outcomes ORDER BY seq,field,entry_key').all()
    const before = saved()
    database.transaction((db) => convertJournalSqlProjection(db, 'session'))
    expect(saved()).toEqual(before)
    const state = new JournalSqlReducer(
      new JournalSqlScope(database.db, 'session', 'epoch'),
      'epoch'
    ).state
    expect(state.inputEntries.get('old')).toEqual({
      context: {
        source: format === 1 ? { epoch: 'epoch', sequence: 3 } : { epoch: 'prior', sequence: 7 },
        basis: 'observed',
        cut: 3
      },
      ...(format === 2 ? { witnessCardId: 'command' } : {})
    })
    expect(journalInputOrder(state).firstQueued()?.clientMessageId).toBe('old')
  }
)

it.each([
  { name: 'lifecycle and rollback', rows: journalSqlLifecycleRows() },
  { name: 'native queue and retry families', rows: journalSqlRetryRows(false) },
  { name: 'legacy queue and retry families', rows: journalSqlRetryRows(true) }
])('converts a saved chat once into the state its open restores: $name', ({ rows }) => {
  database.transaction((db) => {
    publishTestJournalEpoch(db, 'session', 'epoch')
    publishJournalOutcomeEpoch(db, 'session', 'epoch', rows).adopt()
  })
  const { db } = database
  const epoch = database.transaction((tx) => convertJournalSqlProjection(tx, 'session'))

  expect(epoch).toBe('epoch')
  expect(currentJournalSqlEpoch(db, 'session')).toBe('epoch')
  const restored = restoreJournal(db, 'session')!.state
  const converted = new JournalSqlReducer(new JournalSqlScope(db, 'session', 'epoch'), 'epoch')
    .state
  expect(journalSqlControlSnapshot(converted)).toEqual(journalSqlControlSnapshot(restored))
  for (const [key, item] of memoryJournalMap(restored.items)) {
    expect(converted.items.get(key)).toEqual(item)
  }
  const pointed = db
    .prepare(`SELECT COUNT(*) AS count FROM journal_proj_item_versions
    WHERE epoch=? AND outcome_seq IS NOT NULL AND inline_json IS NULL`)
    .get('epoch')?.count
  expect(pointed).toBeGreaterThan(0)
})

it('leaves a chat with no saved history for its first open to found', () => {
  database.transaction((db) => publishTestJournalEpoch(db, 'session', 'epoch'))
  expect(database.transaction((tx) => convertJournalSqlProjection(tx, 'session'))).toBeNull()
  expect(currentJournalSqlEpoch(database.db, 'session')).toBeNull()
})

it('publishes a conversion only while the log still has the coverage it was read at', () => {
  database.transaction((db) => {
    publishTestJournalEpoch(db, 'session', 'epoch')
    publishJournalOutcomeEpoch(db, 'session', 'epoch', journalSqlLifecycleRows()).adopt()
  })
  database.transaction((db) => {
    db.exec(journalSqlProjectionSchema())
    const conversion = prepareJournalSqlConversion(db, 'session')!
    publishTestJournalEpoch(db, 'session', 'replaced')
    expect(finishJournalSqlConversion(db, conversion)).toBe(false)
  })
  expect(currentJournalSqlEpoch(database.db, 'session')).toBeNull()
})

it('sweeps a retired epoch in bounded pages and keeps every current one', () => {
  for (const session of ['retired', 'current']) {
    database.transaction((db) => {
      publishTestJournalEpoch(db, session, 'epoch')
      publishJournalOutcomeEpoch(db, session, 'epoch', journalSqlLifecycleRows()).adopt()
    })
    database.transaction((db) => convertJournalSqlProjection(db, session))
  }
  const { db } = database
  const rows = (session: string) =>
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'
      AND name LIKE 'journal_proj_%' AND name <> 'journal_proj_meta'`)
      .all()
      .reduce(
        (count, { name }) =>
          count +
          Number(
            db
              .prepare(`SELECT COUNT(*) AS n FROM "${String(name)}" WHERE session_id=?`)
              .get(session)?.n
          ),
        0
      )
  const kept = rows('current')
  db.prepare(`UPDATE journal_proj_meta SET epoch='later' WHERE session_id='retired'`).run()
  let pages = 0
  while (database.transaction((tx) => sweepJournalSqlProjectionPage(tx, 8))) {
    pages++
  }
  expect(pages).toBeGreaterThan(1)
  expect(rows('retired')).toBe(0)
  expect(rows('current')).toBe(kept)
})
