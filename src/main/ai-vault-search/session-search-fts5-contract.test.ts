import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type SyncDatabase from '../sqlite/sync-database'
import { resetSessionParseCacheForTests } from '../ai-vault/session-scanner-parse-cache'
import { registerSessionSearchIndexSink } from '../ai-vault/session-search-capture'
import { openSessionSearchDatabase } from './session-search-schema'
import { SessionSearchStore } from './session-search-store'
import { parseTranscript as parse, userRecord } from './session-search-transcript-fixtures'

// SQLite/FTS5 behaviours the query layer depends on. Each one cost a live
// debugging session; a refactor that reintroduces the trap fails here.

const FIRST_ROWID = 101
const SECOND_ROWID = 202

let tempRoots: string[] = []

beforeEach(() => {
  resetSessionParseCacheForTests()
})

afterEach(async () => {
  registerSessionSearchIndexSink(null)
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })))
  tempRoots = []
})

async function makeTempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-fts5-contract-'))
  tempRoots.push(root)
  return root
}

async function openDatabase(): Promise<SyncDatabase> {
  const root = await makeTempDir()
  return openSessionSearchDatabase(join(root, 'index.sqlite'))
}

function insertMessageRow(db: SyncDatabase, rowid: number, text: string): void {
  db.prepare(
    `INSERT INTO messages_fts(rowid, user_text, assistant_text, tool_text, identifiers)
     VALUES (?, ?, '', '', '')`
  ).run(rowid, text)
}

describe('FTS5 aux functions take the table name, never an alias', () => {
  it('rejects bm25 over an aliased table and accepts the table-name form', async () => {
    const db = await openDatabase()
    insertMessageRow(db, FIRST_ROWID, 'alpha marmoset one')

    expect(() =>
      db.prepare('SELECT bm25(f) AS score FROM messages_fts f WHERE f MATCH ?').all('alpha')
    ).toThrow(/no such column: f/)

    const scored = db
      .prepare('SELECT bm25(messages_fts) AS score FROM messages_fts WHERE messages_fts MATCH ?')
      .all('alpha') as { score: number }[]
    expect(scored).toHaveLength(1)
    expect(Number.isFinite(scored[0]?.score)).toBe(true)
    db.close()
  })

  it('rejects snippet over an aliased table too', async () => {
    const db = await openDatabase()
    insertMessageRow(db, FIRST_ROWID, 'alpha marmoset one')

    expect(() =>
      db
        .prepare(
          "SELECT snippet(f, -1, '[', ']', '…', 12) AS s FROM messages_fts f WHERE f MATCH ?"
        )
        .all('alpha')
    ).toThrow(/no such column: f/)
    db.close()
  })
})

describe('a rowid constraint beside MATCH is honoured only as a subselect', () => {
  it('ignores `rowid = ?` and returns every match, first row first', async () => {
    const db = await openDatabase()
    insertMessageRow(db, FIRST_ROWID, 'alpha marmoset one')
    insertMessageRow(db, SECOND_ROWID, 'alpha capybara two')

    const rows = db
      .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid = ?')
      .all('alpha', SECOND_ROWID) as { rowid: number }[]
    // The planner drops the constraint entirely: both rows come back.
    expect(rows.map((row) => row.rowid)).toEqual([FIRST_ROWID, SECOND_ROWID])
    // A caller reading one row therefore gets the first match, not the one asked for.
    const single = db
      .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid = ?')
      .get('alpha', SECOND_ROWID) as { rowid: number } | undefined
    expect(single?.rowid).toBe(FIRST_ROWID)
    db.close()
  })

  it('ignores `rowid IN (?)` the same way', async () => {
    const db = await openDatabase()
    insertMessageRow(db, FIRST_ROWID, 'alpha marmoset one')
    insertMessageRow(db, SECOND_ROWID, 'alpha capybara two')

    const rows = db
      .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid IN (?)')
      .all('alpha', SECOND_ROWID) as { rowid: number }[]
    expect(rows.map((row) => row.rowid)).toEqual([FIRST_ROWID, SECOND_ROWID])
    db.close()
  })

  it('honours `rowid IN (SELECT ?)` and returns the requested row alone', async () => {
    const db = await openDatabase()
    insertMessageRow(db, FIRST_ROWID, 'alpha marmoset one')
    insertMessageRow(db, SECOND_ROWID, 'alpha capybara two')

    const rows = db
      .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? AND rowid IN (SELECT ?)')
      .all('alpha', SECOND_ROWID) as { rowid: number }[]
    expect(rows.map((row) => row.rowid)).toEqual([SECOND_ROWID])

    const snippet = db
      .prepare(
        `SELECT snippet(messages_fts, -1, '[', ']', '…', 12) AS s
         FROM messages_fts WHERE messages_fts MATCH ? AND rowid IN (SELECT ?)`
      )
      .get('alpha', SECOND_ROWID) as { s: string } | undefined
    expect(snippet?.s).toContain('capybara')
    expect(snippet?.s).not.toContain('marmoset')
    db.close()
  })
})

describe('sessions.file_path is deliberately not unique', () => {
  it('accepts two sessions sharing one store path', async () => {
    const db = await openDatabase()
    const insert = db.prepare(
      `INSERT INTO sessions(agent, session_id, file_path, title, resume_command)
       VALUES (?, ?, ?, ?, ?)`
    )
    // OpenCode and Cursor keep every session in one SQLite store; files.path is the key.
    const storePath = '/home/user/.local/share/opencode/storage.db'
    insert.run('opencode', 'ses_one', storePath, 'first', 'opencode --session ses_one')
    expect(() =>
      insert.run('opencode', 'ses_two', storePath, 'second', 'opencode --session ses_two')
    ).not.toThrow()

    const rows = db
      .prepare('SELECT session_id FROM sessions WHERE file_path = ? ORDER BY session_id')
      .all(storePath) as { session_id: string }[]
    expect(rows.map((row) => row.session_id)).toEqual(['ses_one', 'ses_two'])
    db.close()
  })
})

describe('SessionSearchStore.search snippets', () => {
  it('takes each snippet from that hit’s own best message', async () => {
    const root = await makeTempDir()
    const store = new SessionSearchStore(join(root, 'index.sqlite'), (error) => {
      throw error
    })
    registerSessionSearchIndexSink(store)

    // Written first, so its message owns the lowest rowid in messages_fts: the
    // row a dropped rowid constraint would hand back for every hit.
    const first = 'aaaaaaaa-0000-4000-8000-0000000000a1'
    const second = 'aaaaaaaa-0000-4000-8000-0000000000a2'
    const firstPath = join(root, `${first}.jsonl`)
    const secondPath = join(root, `${second}.jsonl`)
    await writeFile(
      firstPath,
      `${userRecord(0, 'hydration marmoset appears once in a long paragraph about routing, caching, layout thrash and other unrelated concerns', first)}\n`
    )
    await writeFile(secondPath, `${userRecord(500, 'hydration capybara', second)}\n`)
    await parse(firstPath)
    await parse(secondPath)

    const result = store.search({ query: 'hydration' })
    expect(result.hits.map((hit) => hit.sessionId)).toEqual([second, first])
    expect(result.hits[0]?.evidence.snippet).toContain('capybara')
    expect(result.hits[0]?.evidence.snippet).not.toContain('marmoset')
    expect(result.hits[1]?.evidence.snippet).toContain('marmoset')
    store.close()
  })
})
