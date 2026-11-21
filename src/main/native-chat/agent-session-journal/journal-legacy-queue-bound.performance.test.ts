import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import type Database from '../../sqlite/sync-database'
import type { SqliteBindings } from '../../sqlite/sqlite-statement'
import { openJournalDatabase } from './database/journal-database'
import { openJournalDomainDatabase } from './database/journal-domain-database'
import { readLegacyProofSessions } from './journal-legacy-content-proof'
import { JournalLegacyRetentionError } from './journal-legacy-retention-error'

// Perf contract (follow-up to #43245): the proof once read every waiting message of a chat into JS
// and serialized it twice before checking its size, about 300-560 MiB at 100k messages. A queue
// is now measured in SQL first: past the limit the original is kept and no queued row is read.

const cleanup: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const close of cleanup.splice(0).toReversed()) {
    close()
  }
})

const QUEUED = 100_000
const TABLES = new Set(['agent_session_records', 'queued_messages', 'journal_outcome_epochs'])

function profile() {
  const root = mkdtempSync(join(tmpdir(), 'orca-legacy-queue-bound-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const { db: source } = openJournalDatabase(join(root, 'source.db'))
  const { db: store } = openJournalDomainDatabase(join(root, 'store.db'))
  cleanup.push(() => source.close())
  cleanup.push(() => store.close())
  return { source, store }
}

/** One chat with a long queue of waiting text, saved by an older Orca. */
function longQueue(source: Database.Database, sessionId: string, recorded: boolean): void {
  source.exec('BEGIN')
  source.prepare("INSERT INTO journal_sessions VALUES(?, 'workspace', 'epoch')").run(sessionId)
  if (recorded) {
    source
      .prepare('INSERT INTO agent_session_records VALUES(?, ?)')
      .run(sessionId, JSON.stringify({ sessionId }))
  }
  const body = JSON.stringify({
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'x'.repeat(512) }]
  })
  const insert = source.prepare(`INSERT INTO queued_messages
    (session_id,message_id,position,body_json,fingerprint,created_at,host_instance,state)
    VALUES(?,?,?,?,'fingerprint',0,'older-host','waiting')`)
  for (let message = 0; message < QUEUED; message++) {
    insert.run(sessionId, `message-${message}`, message, body)
  }
  source.exec('COMMIT')
}

/** Counts the queued rows any statement reading queued text hands to JS. */
function countQueuedRowsRead(source: Database.Database): { rows: number; sorted: string[] } {
  // One count at a time: an earlier wrapper would count, and call, itself.
  vi.restoreAllMocks()
  const sorted: string[] = []
  const counted = { rows: 0, sorted }
  const prepare = source.prepare.bind(source)
  vi.spyOn(source, 'prepare').mockImplementation((sql: string) => {
    const statement = prepare(sql)
    if (!/FROM queued_messages/.test(sql) || /COUNT\(\*\)|SELECT 1 |^EXPLAIN/.test(sql)) {
      return statement
    }
    // SQLite sorting a whole queue into a temp B-tree reads every row before the first one is
    // handed over, however few reach JS.
    const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all(
        ...sql
          .split('?')
          .slice(1)
          .map(() => null)
      )
      .map((step) => String(step.detail))
    if (plan.some((detail) => detail.includes('TEMP B-TREE'))) {
      counted.sorted.push(sql)
    }
    const { get, all, iterate } = statement
    statement.get = (...args: SqliteBindings) => {
      const row = get.apply(statement, args)
      counted.rows += row === undefined ? 0 : 1
      return row
    }
    statement.all = (...args: SqliteBindings) => {
      const rows = all.apply(statement, args)
      counted.rows += rows.length
      return rows
    }
    statement.iterate = function* (...args: SqliteBindings) {
      for (const row of iterate.apply(statement, args)) {
        counted.rows += 1
        yield row
      }
    }
    return statement
  })
  return counted
}

function refusal(read: () => unknown): unknown {
  try {
    read()
  } catch (error) {
    return error
  }
  return undefined
}

it('keeps the original for a chat with 100k waiting messages without reading them into memory', () => {
  const { source, store } = profile()
  // Deleted here: the chat always keeps the original's version, queue included.
  longQueue(source, 'deleted-here', true)
  store
    .prepare('INSERT INTO agent_session_store_meta(key,value) VALUES(?,?)')
    .run('journal.legacy-revision:deleted-here', JSON.stringify(['epoch', 0, null, null]))
  // Converted here without a record: its waiting text would be compared card by card.
  longQueue(source, 'unrecorded', false)
  store.exec(`INSERT INTO journal_chat_state(session_id, workspace_id, epoch)
    VALUES('unrecorded', 'workspace', 'epoch')`)

  for (const chat of ['deleted-here', 'unrecorded']) {
    const counted = countQueuedRowsRead(source)
    const error = refusal(() =>
      readLegacyProofSessions(
        source,
        store,
        TABLES,
        chat === 'deleted-here' ? null : 'deleted-here'
      )
    )
    expect(error).toBeInstanceOf(JournalLegacyRetentionError)
    expect(error).toMatchObject({ reason: 'source-oversize' })
    expect(counted.rows).toBe(0)
    expect(counted.sorted).toEqual([])
  }
})
