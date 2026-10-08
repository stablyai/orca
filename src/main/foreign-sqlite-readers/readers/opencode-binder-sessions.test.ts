import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { readOpenCodeBinderSessions } from './opencode-binder-sessions'

const DIR = '/tmp/binder-worktree-a'
const START = { ms: 0, id: '' }

let dir = ''
let dbPath = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-opencode-binder-reader-'))
  dbPath = join(dir, 'opencode.db')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeSessions(
  table: 'session' | 'session_v2',
  rows: { id: string; createdAtMs: number; parentId?: string }[]
): void {
  const db = new SyncDatabase(dbPath)
  try {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL, parent_id TEXT)`
    )
    const insert = db.prepare(
      `INSERT INTO ${table} (id, directory, time_created, parent_id) VALUES (?, ?, ?, ?)`
    )
    for (const row of rows) {
      insert.run(row.id, DIR, row.createdAtMs, row.parentId ?? null)
    }
  } finally {
    db.close()
  }
}

describe('readOpenCodeBinderSessions', () => {
  it('reads OpenCode 1 rows past the cursor, oldest first', () => {
    writeSessions('session', [
      { id: 'ses_b', createdAtMs: 200, parentId: 'ses_a' },
      { id: 'ses_a', createdAtMs: 100 }
    ])
    expect(readOpenCodeBinderSessions(dbPath, START)).toEqual([
      { id: 'ses_a', directory: DIR, createdAtMs: 100, parentId: null },
      { id: 'ses_b', directory: DIR, createdAtMs: 200, parentId: 'ses_a' }
    ])
    expect(readOpenCodeBinderSessions(dbPath, { ms: 200, id: 'ses_b' })).toEqual([])
  })

  it('re-lists rows that share the cursor millisecond with a later id', () => {
    writeSessions('session', [
      { id: 'ses_a', createdAtMs: 100 },
      { id: 'ses_b', createdAtMs: 100 }
    ])
    expect(
      readOpenCodeBinderSessions(dbPath, { ms: 100, id: 'ses_a' }).map((row) => row.id)
    ).toEqual(['ses_b'])
  })

  it('skips OpenCode 2 rows in a database both versions wrote', () => {
    writeSessions('session', [{ id: 'ses_v1', createdAtMs: 100 }])
    writeSessions('session_v2', [{ id: 'ses_v2', createdAtMs: 100 }])
    expect(readOpenCodeBinderSessions(dbPath, START).map((row) => row.id)).toEqual(['ses_v1'])
  })

  it('reads a store without the session table as empty', () => {
    writeSessions('session_v2', [{ id: 'ses_v2', createdAtMs: 100 }])
    expect(readOpenCodeBinderSessions(dbPath, START)).toEqual([])
  })

  // #24577: an absent store is normal, so it answers [] and the client logs nothing.
  it('reads a missing database as empty and detects it once it appears', () => {
    expect(readOpenCodeBinderSessions(join(dir, 'later.db'), START)).toEqual([])
    expect(readOpenCodeBinderSessions(join(dir, 'missing', 'opencode.db'), START)).toEqual([])
    dbPath = join(dir, 'later.db')
    writeSessions('session', [{ id: 'ses_a', createdAtMs: 100 }])
    expect(readOpenCodeBinderSessions(dbPath, START)).toHaveLength(1)
  })

  it('throws for a corrupt database so the client logs it and answers its failure value', () => {
    writeFileSync(dbPath, 'not a sqlite database'.repeat(100))
    expect(() => readOpenCodeBinderSessions(dbPath, START)).toThrow()
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'throws when an existing database is behind an inaccessible directory',
    () => {
      writeSessions('session', [{ id: 'ses_a', createdAtMs: 100 }])
      try {
        chmodSync(dir, 0o000)
        expect(() => readOpenCodeBinderSessions(dbPath, START)).toThrow(
          expect.objectContaining({ code: 'EACCES' })
        )
      } finally {
        chmodSync(dir, 0o700)
      }
    }
  )
})
