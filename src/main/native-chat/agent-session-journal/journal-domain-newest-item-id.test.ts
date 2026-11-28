import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { openJournalDomainDatabase } from './database/journal-domain-database'
import {
  ensureJournalClaudeRefusalIndexes,
  JOURNAL_CLAUDE_REFUSAL_POSITION_INDEX,
  JOURNAL_CLAUDE_REFUSAL_PREFIX,
  JOURNAL_CLAUDE_REFUSAL_ROWS,
  JOURNAL_CLAUDE_REFUSAL_TIMED_INDEX,
  JOURNAL_CLAUDE_REFUSAL_TIMED_ROWS
} from './database/journal-claude-refusal-indexes'
import { applyJournalDomainItem } from './journal-domain-item'
import { readJournalDomainEntity } from './journal-domain-entity-read'
import { readJournalSqlProjection } from './journal-sql-read-transaction'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_SESSION_TURN_NOTICE_PRESENTATION } from '../../../shared/agent-session/journal/agent-session-turn-notice'

// The newest saved permission row is the visible one appended last, even when a clock moved back
// gave it a lower id; the floor for new ids is the greatest visible timed id. Each answer is one
// seek of its own partial index, however many hidden, older or unrelated rows the chat holds.

const directories: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

const PREFIX = 'full-access-refused:claude:'
const key = (clientMessageId: string) => agentJournalItemKey({ provider: 'orca', clientMessageId })
const timed = (time: number, notice: string) =>
  `${PREFIX}t${time.toString(36).padStart(10, '0')}:6f1c2a4e-1d3b-4c55-9e7a-0b8f3d2c1a90:1:${notice}`

function journal() {
  const directory = mkdtempSync(join(tmpdir(), 'orca-newest-item-id-'))
  directories.push(directory)
  const filename = join(directory, 'journal.sqlite')
  const { db } = openJournalDomainDatabase(filename)
  ensureJournalClaudeRefusalIndexes(db)
  db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_sequence,highest_fence)
    VALUES('chat','workspace','epoch',0,1)`).run()
  const append = (clientMessageId: string) =>
    applyJournalDomainItem(
      db,
      { sessionId: 'chat', epoch: 'epoch' },
      {
        kind: 'item',
        identity: { provider: 'orca', clientMessageId },
        body: {
          kind: 'status',
          tone: 'warning',
          presentation: AGENT_SESSION_TURN_NOTICE_PRESENTATION,
          text: clientMessageId
        },
        options: { turnScope: { kind: 'thread' }, fence: 1 }
      },
      1_800_000_000_000
    )
  const reader = new Database(filename, { readonly: true, fileMustExist: true })
  const read = (between?: () => void) =>
    readJournalSqlProjection(reader, 'chat', (scope) => {
      between?.()
      const { itemId, greatestTimedId } = readJournalDomainEntity(scope, {
        kind: 'newest-item-id',
        prefix: JOURNAL_CLAUDE_REFUSAL_PREFIX,
        timedFrom: 't'
      }) as { itemId: string | null; greatestTimedId: string | null }
      return { itemId, greatestTimedId }
    })
  // A build that never names these indexes, writing through its own connection.
  const older = new Database(filename)
  return { db, append, reader, read, older, filename }
}

it('answers each saved permission row question from one seek, through every kind of change', () => {
  const { db, append, reader, read, older, filename } = journal()
  const transaction = (run: () => void) => {
    db.exec('BEGIN IMMEDIATE')
    run()
    db.exec('COMMIT')
  }
  const head = (itemId: string | null, greatestTimedId: string | null) => ({
    itemId: itemId && key(itemId),
    greatestTimedId: greatestTimedId && key(greatestTimedId)
  })
  transaction(() => append('unrelated-0'))
  expect(read()).toEqual(head(null, null))

  const legacy = `${PREFIX}settings`
  const recovery = timed(9_000, 'restored:bypassPermissions')
  // Minted after the clock moved back: a lower id, appended later.
  const warning = timed(5_000, 'running')
  transaction(() => append(legacy))
  expect(read()).toEqual(head(legacy, null))
  transaction(() => {
    append(recovery)
    for (let index = 1; index <= 200; index += 1) {
      append(`unrelated-${index}`)
    }
    append(warning)
  })
  expect(read()).toEqual(head(warning, recovery))

  // Hidden rows above both answers are in neither index, so no seek walks them.
  const hiddenTail = Array.from({ length: 200 }, (_, index) => timed(20_000 + index, 'running'))
  transaction(() => {
    for (const itemId of hiddenTail) {
      append(itemId)
    }
  })
  older
    .prepare(`UPDATE journal_items SET hidden=1 WHERE item_id>=? AND item_id<?`)
    .run(key(hiddenTail[0]!), `${JOURNAL_CLAUDE_REFUSAL_PREFIX}\uffff`)
  older.prepare(`UPDATE journal_items SET hidden=1 WHERE item_id=?`).run(key(warning))
  expect(read()).toEqual(head(recovery, recovery))
  older.prepare(`UPDATE journal_items SET hidden=0 WHERE item_id=?`).run(key(warning))
  expect(read()).toEqual(head(warning, recovery))

  const statements: string[] = []
  const prepare = reader.prepare.bind(reader)
  vi.spyOn(reader, 'prepare').mockImplementation((sql: string) => {
    statements.push(sql)
    return prepare(sql)
  })
  read()
  vi.restoreAllMocks()
  const seeks = statements.filter((sql) => sql.includes('INDEXED BY'))
  const plan = (sql: string) =>
    reader
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all('chat', 'epoch')
      .map((row) => String(row.detail))
  expect(seeks.map(plan)).toEqual([
    [
      'SEARCH journal_items USING INDEX journal_items_claude_refusal_position (session_id=? AND epoch=?)'
    ],
    [
      'SEARCH journal_items USING INDEX journal_items_claude_refusal_timed_id (session_id=? AND epoch=? AND item_id>? AND item_id<?)'
    ]
  ])
  // Each index holds only the rows its answer can be, so the first entry the seek reaches answers.
  const entries = (index: string, rows: string) =>
    Number(
      reader
        .prepare(`SELECT count(*) AS entries FROM journal_items INDEXED BY ${index}
        WHERE session_id=? AND epoch=? AND ${rows}`)
        .get('chat', 'epoch')!.entries
    )
  expect([
    entries(JOURNAL_CLAUDE_REFUSAL_POSITION_INDEX, JOURNAL_CLAUDE_REFUSAL_ROWS),
    entries(JOURNAL_CLAUDE_REFUSAL_TIMED_INDEX, JOURNAL_CLAUDE_REFUSAL_TIMED_ROWS)
  ]).toEqual([3, 2])

  // Moved by a context replacement, then rows sharing leading position components.
  const sequenceOf = (itemId: string) =>
    Number(
      db.prepare(`SELECT sequence FROM journal_items WHERE item_id=?`).get(key(itemId))!.sequence
    )
  const top = sequenceOf(warning) + 1
  older.prepare(`UPDATE journal_items SET sequence=? WHERE item_id=?`).run(top, key(legacy))
  expect(read()).toEqual(head(legacy, recovery))
  older.prepare(`UPDATE journal_items SET sequence=? WHERE item_id=?`).run(top, key(recovery))
  older.prepare(`UPDATE journal_items SET sequence_index=1 WHERE item_id=?`).run(key(legacy))
  expect(read()).toEqual(head(legacy, recovery))
  // Same sequence and index: the later ordinal, appended after the legacy row.
  older.prepare(`UPDATE journal_items SET sequence_index=1 WHERE item_id=?`).run(key(recovery))
  expect(read()).toEqual(head(recovery, recovery))

  older.prepare(`DELETE FROM journal_items WHERE item_id=?`).run(key(recovery))
  expect(read()).toEqual(head(legacy, warning))
  // An import's upsert brings it back, visible, at a later position.
  older
    .prepare(`INSERT INTO journal_items(session_id,epoch,item_id,ordinal,revision,sequence,
      sequence_index,owner_fence,payload_json) VALUES('chat','epoch',?,9999,1,?,0,1,'{}')
      ON CONFLICT(session_id,epoch,item_id) DO UPDATE SET hidden=0,sequence=excluded.sequence`)
    .run(key(recovery), top + 1)
  expect(read()).toEqual(head(recovery, recovery))

  older
    .prepare(`UPDATE journal_items SET hidden=1 WHERE item_id>=? AND item_id<?`)
    .run(JOURNAL_CLAUDE_REFUSAL_PREFIX, `${JOURNAL_CLAUDE_REFUSAL_PREFIX}\uffff`)
  expect(read()).toEqual(head(null, null))
  older
    .prepare(`UPDATE journal_items SET hidden=0 WHERE item_id IN (?,?,?)`)
    .run(key(legacy), key(recovery), key(warning))

  // A rolled-back write changes neither answer, before or after reopening.
  db.exec('BEGIN IMMEDIATE')
  append(timed(30_000, 'settings'))
  db.exec('ROLLBACK')
  expect(read()).toEqual(head(recovery, recovery))
  db.close()
  const reopened = openJournalDomainDatabase(filename).db
  ensureJournalClaudeRefusalIndexes(reopened)
  expect(read()).toEqual(head(recovery, recovery))

  // A read keeps the epoch and rows of its own snapshot while another epoch is published.
  const next = timed(40_000, 'settings')
  older
    .prepare(`INSERT INTO journal_items(session_id,epoch,item_id,ordinal,revision,sequence,
      sequence_index,owner_fence,payload_json) VALUES('chat','next',?,1,1,1,0,1,'{}')`)
    .run(key(next))
  expect(
    read(() => {
      older.prepare(`UPDATE journal_chat_state SET epoch='next' WHERE session_id='chat'`).run()
    })
  ).toEqual(head(recovery, recovery))
  expect(read()).toEqual(head(next, next))
  reopened.close()
  older.close()
  reader.close()
})

it('fails a read whose index is missing, and builds both or names a conflicting one', () => {
  const { db, read, reader, older } = journal()
  const timedIndex = JOURNAL_CLAUDE_REFUSAL_TIMED_INDEX
  db.exec(`DROP INDEX ${timedIndex}`)
  expect(() => read()).toThrow(`no such index: ${timedIndex}`)
  expect(() =>
    readJournalSqlProjection(reader, 'chat', (scope) =>
      readJournalDomainEntity(scope, {
        kind: 'newest-item-id',
        prefix: key('other:'),
        timedFrom: 't'
      })
    )
  ).toThrow('only saved Claude permission rows')

  // Another object under one name fails the pair; the other is not left built alone.
  db.exec(`DROP INDEX ${JOURNAL_CLAUDE_REFUSAL_POSITION_INDEX}`)
  db.exec(`CREATE VIEW ${timedIndex} AS SELECT 1`)
  expect(() => ensureJournalClaudeRefusalIndexes(db)).toThrow()
  const indexes = () =>
    db
      .prepare(`SELECT name FROM sqlite_schema WHERE name LIKE 'journal_items_claude_refusal_%'
      AND type='index' ORDER BY name`)
      .all()
      .map((row) => String(row.name))
  expect(indexes()).toEqual([])
  db.exec(`DROP VIEW ${timedIndex}`)

  // An interrupted earlier build left one: the missing one is added.
  ensureJournalClaudeRefusalIndexes(db)
  db.exec(`DROP INDEX ${timedIndex}`)
  ensureJournalClaudeRefusalIndexes(db)
  expect(indexes()).toEqual([JOURNAL_CLAUDE_REFUSAL_POSITION_INDEX, timedIndex])
  expect(read()).toEqual({ itemId: null, greatestTimedId: null })

  db.exec(`DROP INDEX ${timedIndex}`)
  db.exec(`CREATE INDEX ${timedIndex} ON journal_items(session_id,epoch,item_id)`)
  expect(() => ensureJournalClaudeRefusalIndexes(db)).toThrow(
    `journal index ${timedIndex} has another definition`
  )
  db.close()
  older.close()
  reader.close()
})
