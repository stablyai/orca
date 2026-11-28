import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openJournalDomainDatabase } from './database/journal-domain-database'
import { runJournalTransaction } from './database/journal-database'
import { JOURNAL_ASYNC_QUESTION_INDEXES } from './database/journal-async-question-index'
import { JOURNAL_ENDED_TURN_COUNTS_SCHEMA } from './database/journal-ended-turn-counts'
import {
  journalItemIndexedColumns,
  writeJournalDomainItemRow,
  type JournalItemRowColumn
} from './journal-domain-item-row-write'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const PREFIX = ['chat', 'epoch'] as const
// Values index predicates test for, so each change also moves the row in or out of partial indexes.
const TEXT: Record<string, readonly [string, string]> = {
  kind: ['turn', 'message'],
  message_role: ['assistant', 'user'],
  lifecycle_state: ['running', 'interrupted'],
  payload_json: ['{"body":{"kind":"turn"}}', '{"body":{"from":"x","t":"request_user_input_async"}}']
}

function value(column: string, type: string, side: 0 | 1): JournalItemRowColumn[1] {
  if (type === 'INTEGER') {
    return side
  }
  if (type === 'REAL') {
    return side + 0.5
  }
  if (type === 'BLOB') {
    return new Uint8Array([side, 7])
  }
  return TEXT[column]?.[side] ?? `${column}-${side}`
}

it('a save that changes any one column leaves the row and every index exact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'item-row-write-'))
  dirs.push(dir)
  const { db } = openJournalDomainDatabase(join(dir, 'journal.db'))
  // The writer worker adds these after open, before its first save.
  db.exec(JOURNAL_ASYNC_QUESTION_INDEXES)
  runJournalTransaction(db, (writer) => writer.exec(JOURNAL_ENDED_TURN_COUNTS_SCHEMA))
  const columns = db
    .prepare(`SELECT name, type FROM pragma_table_info('journal_items')`)
    .all()
    .map((row) => ({ name: String(row.name), type: String(row.type) }))
    .filter(({ name }) => !['session_id', 'epoch', 'item_id'].includes(name))
  // SQLite's own plan says which columns an UPDATE must maintain an index for.
  const maintainsIndex = (column: string) =>
    db
      .prepare(
        `EXPLAIN UPDATE journal_items SET ${column}=? WHERE session_id=? AND epoch=? AND item_id=?`
      )
      .all()
      .some(({ opcode }) => opcode === 'IdxInsert' || opcode === 'IdxDelete')
  const indexed = journalItemIndexedColumns(db)
  expect(
    columns.filter(({ name }) => indexed.has(name) !== maintainsIndex(name)).map(({ name }) => name)
  ).toEqual([])

  const row = (side: (name: string) => 0 | 1): JournalItemRowColumn[] =>
    columns.map(({ name, type }) => [name, value(name, type, side(name))])
  const save = (values: JournalItemRowColumn[]) => {
    runJournalTransaction(db, () => writeJournalDomainItemRow(db, PREFIX, 'item', values))
    const stored = db
      .prepare('SELECT * FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?')
      .get(...PREFIX, 'item')!
    for (const [name, expected] of values) {
      expect([name, stored[name]]).toEqual([name, expected])
    }
    expect(db.prepare('PRAGMA integrity_check').get()!.integrity_check).toBe('ok')
  }

  for (const base of [0, 1] as const) {
    save(row(() => base))
    for (const { name } of columns) {
      save(row((column) => (column === name ? (base === 0 ? 1 : 0) : base)))
      save(row(() => base))
    }
  }
  db.close()
})
