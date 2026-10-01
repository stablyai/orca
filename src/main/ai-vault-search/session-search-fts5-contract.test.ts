import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import type SyncDatabase from '../sqlite/sync-database'
import { indexTokens } from './session-search-query-planner'
import { ensureSessionSearchQuerySchema } from './session-search-query-schema'
import { openSessionSearchDatabase } from './session-search-schema'

// SQLite/FTS5 behaviours the query layer depends on. Each one cost a live
// debugging session; a refactor that reintroduces the trap fails here.

const FIRST_ROWID = 101
const SECOND_ROWID = 202

let tempRoots: string[] = []

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => removeTree(root)))
  tempRoots = []
})

async function openDatabase(): Promise<SyncDatabase> {
  const root = await mkdtemp(join(tmpdir(), 'orca-fts5-contract-'))
  tempRoots.push(root)
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

  it('honours `rowid IN (SELECT ?)` even with the session join on', async () => {
    const db = await openDatabase()
    db.prepare(
      `INSERT INTO sessions(id,agent,session_id,file_path,title,resume_command)
       VALUES (1,'claude','1','/synthetic/1','fixture','')`
    ).run()
    for (const rowid of [FIRST_ROWID, SECOND_ROWID]) {
      db.prepare("INSERT INTO messages(id,session_row_id,role) VALUES (?,1,'user')").run(rowid)
    }
    insertMessageRow(db, FIRST_ROWID, 'alpha marmoset one')
    insertMessageRow(db, SECOND_ROWID, 'alpha capybara two')

    // The shape the snippet read uses: the joins are what subtract a row whose
    // session a purge cut loose, and they must not cost the rowid constraint
    // its effect.
    const snippet = db
      .prepare(
        `SELECT snippet(messages_fts, -1, '[', ']', '…', 12) AS s
         FROM messages_fts
         JOIN messages m ON m.id = messages_fts.rowid
         JOIN sessions s ON s.id = m.session_row_id
         WHERE messages_fts MATCH ? AND messages_fts.rowid IN (SELECT ?)`
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

describe('the planner tokenizer draws the same boundaries as unicode61', () => {
  // unicode61 folds case and strips Latin diacritics on both index and query side.
  function asIndexed(token: string): string {
    return token.toLowerCase().normalize('NFD').replaceAll(/\p{M}/gu, '')
  }

  it('produces exactly the terms fts5vocab reports for the same text', async () => {
    const db = await openDatabase()
    // The vocabulary is the engine's own object, not the store's.
    ensureSessionSearchQuerySchema(db)
    const corpus =
      'resolveTerminalPath src/main/foo-bar.ts a.b C++ #123 修复 café naïve MAX_TOKEN x'
    insertMessageRow(db, FIRST_ROWID, corpus)
    const indexed = (
      db.prepare('SELECT term FROM messages_vocab ORDER BY term').all() as { term: string }[]
    ).map((row) => row.term)

    expect([...new Set(indexTokens(corpus).map(asIndexed))].sort()).toEqual(indexed)
    db.close()
  })
})
