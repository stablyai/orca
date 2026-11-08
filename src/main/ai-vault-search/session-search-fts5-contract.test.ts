import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTree } from '../../shared/windows-transient-lock-removal'
import type SyncDatabase from '../sqlite/sync-database'
import { indexTokens } from './session-search-query-planner'
import { ensureSessionSearchQuerySchema } from './session-search-query-schema'
import { openSessionSearchDatabase } from './session-search-schema'

const FIRST_ROWID = 101

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

describe('sessions.file_path is deliberately not unique', () => {
  it('accepts two sessions sharing one store path', async () => {
    const db = await openDatabase()
    const insert = db.prepare(
      `INSERT INTO sessions(agent, session_id, file_path, title, resume_command)
       VALUES (?, ?, ?, ?, ?)`
    )
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
  function asIndexed(token: string): string {
    return token.toLowerCase().normalize('NFD').replaceAll(/\p{M}/gu, '')
  }

  it('produces exactly the terms fts5vocab reports for the same text', async () => {
    const db = await openDatabase()
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
