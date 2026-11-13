import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import Database from '../../../sqlite/sync-database'
import {
  readOpenCodeTranscriptPage,
  readOpenCodeTranscriptSignal
} from './transcript-opencode-sqlite-query'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup()
  }
  vi.useRealTimers()
})

function fixture(sequenced = true) {
  const root = mkdtempSync(join(tmpdir(), 'orca-zcode-transcript-'))
  const dbPath = join(root, 'db.sqlite')
  const db = new Database(dbPath)
  cleanups.push(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER${sequenced ? ', sequence INTEGER' : ''});
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT, time_created INTEGER, time_updated INTEGER${sequenced ? ', sequence INTEGER' : ''});
    INSERT INTO session VALUES ('session');
  `)
  const insert = (id: string, sequence: number | null, visibility?: string) => {
    const values = [
      id,
      'session',
      JSON.stringify({ role: 'user', semantics: { transcriptVisibility: visibility } }),
      1,
      1
    ]
    db.prepare(`INSERT INTO message VALUES (?, ?, ?, ?, ?${sequenced ? ', ?' : ''})`).run(
      ...values,
      ...(sequenced ? [sequence] : [])
    )
    db.prepare(`INSERT INTO part VALUES (?, ?, ?, ?, 1, 1${sequenced ? ', ?' : ''})`).run(
      id,
      id,
      'session',
      JSON.stringify({ type: 'text', text: id }),
      ...(sequenced ? [0] : [])
    )
  }
  const deps = {
    resolveDbPath: vi.fn(async () => dbPath),
    readSignal: async (path: string, sessionId: string, _signal?: AbortSignal, agent?: 'zcode') =>
      readOpenCodeTranscriptSignal(path, sessionId, agent),
    readPage: async (args: Parameters<typeof readOpenCodeTranscriptPage>[0]) =>
      readOpenCodeTranscriptPage(args)
  }
  return { db, dbPath, insert, deps }
}

it('keeps a paging cursor stable when earlier messages are removed or imported', () => {
  const f = fixture()
  f.insert('last', 3)
  f.insert('first', 0)
  f.insert('middle', 2)
  const newest = readOpenCodeTranscriptPage({
    dbPath: f.dbPath,
    sessionId: 'session',
    limit: 1,
    agent: 'zcode'
  })
  f.db.prepare('DELETE FROM message WHERE id = ?').run('first')
  f.db.prepare('DELETE FROM part WHERE message_id = ?').run('first')
  f.insert('imported', 1)
  const older = readOpenCodeTranscriptPage({
    dbPath: f.dbPath,
    sessionId: 'session',
    limit: 10,
    agent: 'zcode',
    beforeMessageRowId: newest?.beforeMessageRowId ?? undefined
  })
  expect(older?.items.map((item) => item.message.id)).toEqual(['imported', 'middle'])
})
