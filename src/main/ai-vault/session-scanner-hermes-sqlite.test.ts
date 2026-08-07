import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import SyncDatabase from '../sqlite/sync-database'
import { listHermesSqliteSessions, parseHermesSqliteSession } from './session-scanner-hermes-sqlite'
import { buildHermesSqliteCandidatePath } from './session-scanner-hermes-sqlite-paths'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots } from './session-scanner-test-fixtures'

describe('Hermes 0.19 SQLite support & legacy backwards compatibility', () => {
  const cleanupDirs: string[] = []

  afterEach(() => {
    for (const dir of cleanupDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function createTestDb(dbPath: string) {
    const db = new SyncDatabase(dbPath)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        cwd TEXT,
        model TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        role TEXT,
        content TEXT,
        created_at TEXT
      );
    `)
    return db
  }

  it('lists and parses sessions from state.db', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-hermes-sqlite-'))
    cleanupDirs.push(dir)
    const dbPath = join(dir, 'state.db')
    const db = createTestDb(dbPath)

    db.prepare(
      `INSERT INTO sessions (id, title, cwd, model, created_at, updated_at)
       VALUES ('hermes-sqlite-1', 'SQLite Session Title', '/tmp/hermes-work', 'hermes-v3', '2026-06-01T10:00:00Z', '2026-06-01T10:05:00Z')`
    ).run()

    db.prepare(
      `INSERT INTO messages (session_id, role, content, created_at)
       VALUES ('hermes-sqlite-1', 'user', 'Hello Hermes', '2026-06-01T10:00:00Z')`
    ).run()

    db.prepare(
      `INSERT INTO messages (session_id, role, content, created_at)
       VALUES ('hermes-sqlite-1', 'assistant', 'Hello from Hermes assistant', '2026-06-01T10:01:00Z')`
    ).run()

    db.close()

    const issues: AiVaultScanIssue[] = []
    const candidates = await listHermesSqliteSessions({
      dbPaths: [dbPath],
      limit: 10,
      issues
    })

    expect(issues).toEqual([])
    expect(candidates).toHaveLength(1)
    expect(candidates[0].file.path).toBe(buildHermesSqliteCandidatePath(dbPath, 'hermes-sqlite-1'))

    const parsed = await parseHermesSqliteSession({
      dbPath,
      sessionId: 'hermes-sqlite-1',
      platform: 'darwin'
    })

    expect(parsed).not.toBeNull()
    expect(parsed?.agent).toBe('hermes')
    expect(parsed?.sessionId).toBe('hermes-sqlite-1')
    expect(parsed?.title).toBe('SQLite Session Title')
    expect(parsed?.cwd).toBe('/tmp/hermes-work')
    expect(parsed?.model).toBe('hermes-v3')
    expect(parsed?.messageCount).toBe(2)
    expect(parsed?.resumeCommand).toBe("cd '/tmp/hermes-work' && hermes --resume 'hermes-sqlite-1'")
  })

  it('scans Hermes SQLite session alongside legacy JSON files with deduplication', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-scan-'))
    cleanupDirs.push(root)
    const roots = isolatedScanRoots(root)
    const dbPath = join(root, 'state.db')
    const db = createTestDb(dbPath)

    db.prepare(
      `INSERT INTO sessions (id, title, cwd, model, created_at, updated_at)
       VALUES ('sqlite-sess-1', 'SQLite Session', '/tmp/hermes-sqlite', 'hermes-0.19', '2026-07-01T10:00:00Z', '2026-07-01T10:10:00Z')`
    ).run()

    db.prepare(
      `INSERT INTO messages (session_id, role, content, created_at)
       VALUES ('sqlite-sess-1', 'user', 'Prompt for SQLite', '2026-07-01T10:00:00Z')`
    ).run()

    db.close()

    // Add legacy JSON session with duplicate session_id to test dedup
    await mkdir(roots.hermesSessionsDir, { recursive: true })
    await writeFile(
      join(roots.hermesSessionsDir, 'session_sqlite-sess-1.json'),
      JSON.stringify({
        session_id: 'sqlite-sess-1',
        model: 'hermes-legacy',
        cwd: '/tmp/legacy',
        messages: [{ role: 'user', content: 'Legacy content' }]
      })
    )

    // Add legacy JSON session with distinct session_id (old session before updating Hermes)
    await writeFile(
      join(roots.hermesSessionsDir, 'session_legacy-old.json'),
      JSON.stringify({
        session_id: 'legacy-old',
        model: 'hermes-legacy',
        cwd: '/tmp/legacy-old',
        messages: [{ role: 'user', content: 'Old Legacy Session' }]
      })
    )

    const scanResult = await scanAiVaultSessions({
      ...roots,
      hermesStateDbPaths: [dbPath],
      platform: 'darwin',
      limit: 10
    })

    const hermesSessions = scanResult.sessions.filter((s) => s.agent === 'hermes')
    expect(hermesSessions).toHaveLength(2)

    const sqliteSession = hermesSessions.find((s) => s.sessionId === 'sqlite-sess-1')
    expect(sqliteSession).toBeDefined()
    expect(sqliteSession?.title).toBe('SQLite Session')
    expect(sqliteSession?.cwd).toBe('/tmp/hermes-sqlite')

    const legacySession = hermesSessions.find((s) => s.sessionId === 'legacy-old')
    expect(legacySession).toBeDefined()
    expect(legacySession?.title).toBe('Old Legacy Session')
  })

  it('scans legacy JSON sessions when state.db does not exist at all (pure fallback)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-fallback-'))
    cleanupDirs.push(root)
    const roots = isolatedScanRoots(root)

    // Do NOT create state.db, only create legacy session files
    await mkdir(roots.hermesSessionsDir, { recursive: true })
    await writeFile(
      join(roots.hermesSessionsDir, 'session_v1-user-session.json'),
      JSON.stringify({
        session_id: 'v1-user-session',
        model: 'hermes-v1',
        cwd: '/tmp/v1-work',
        session_start: '2026-04-01T10:00:00.000Z',
        last_updated: '2026-04-01T10:05:00.000Z',
        messages: [{ role: 'user', content: 'Pure Legacy Hermes Title' }]
      })
    )

    const scanResult = await scanAiVaultSessions({
      ...roots,
      platform: 'darwin',
      limit: 10
    })

    const hermesSessions = scanResult.sessions.filter((s) => s.agent === 'hermes')
    expect(hermesSessions).toHaveLength(1)
    expect(hermesSessions[0].sessionId).toBe('v1-user-session')
    expect(hermesSessions[0].title).toBe('Pure Legacy Hermes Title')
    expect(hermesSessions[0].cwd).toBe('/tmp/v1-work')
    expect(hermesSessions[0].resumeCommand).toBe(
      "cd '/tmp/v1-work' && hermes --resume 'v1-user-session'"
    )
  })

  it('parses numeric timestamp strings in state.db rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-hermes-numeric-ts-'))
    cleanupDirs.push(dir)
    const dbPath = join(dir, 'state.db')
    const db = createTestDb(dbPath)

    db.prepare(
      `INSERT INTO sessions (id, title, cwd, model, created_at, updated_at)
       VALUES ('ts-sess-1', 'Numeric Timestamp Session', '/tmp/work', 'hermes-v3', '1722000000', '1722000300')`
    ).run()

    db.prepare(
      `INSERT INTO messages (session_id, role, content, created_at)
       VALUES ('ts-sess-1', 'user', 'Hello', '1722000000')`
    ).run()
    db.close()

    const candidates = await listHermesSqliteSessions({ dbPaths: [dbPath], limit: 10, issues: [] })
    expect(candidates).toHaveLength(1)
    expect(candidates[0].file.mtimeMs).toBe(1722000300000)
  })

  it('sorts candidate sessions across multiple databases by recency', async () => {
    const dir1 = mkdtempSync(join(tmpdir(), 'orca-hermes-db1-'))
    const dir2 = mkdtempSync(join(tmpdir(), 'orca-hermes-db2-'))
    cleanupDirs.push(dir1, dir2)

    const dbPath1 = join(dir1, 'state.db')
    const dbPath2 = join(dir2, 'state.db')

    const db1 = createTestDb(dbPath1)
    db1
      .prepare(
        `INSERT INTO sessions (id, created_at, updated_at) VALUES ('older-sess', '2026-01-01T10:00:00Z', '2026-01-01T10:00:00Z')`
      )
      .run()
    db1
      .prepare(
        `INSERT INTO messages (session_id, role, content) VALUES ('older-sess', 'user', 'msg')`
      )
      .run()
    db1.close()

    const db2 = createTestDb(dbPath2)
    db2
      .prepare(
        `INSERT INTO sessions (id, created_at, updated_at) VALUES ('newer-sess', '2026-06-01T10:00:00Z', '2026-06-01T10:00:00Z')`
      )
      .run()
    db2
      .prepare(
        `INSERT INTO messages (session_id, role, content) VALUES ('newer-sess', 'user', 'msg')`
      )
      .run()
    db2.close()

    const candidates = await listHermesSqliteSessions({
      dbPaths: [dbPath1, dbPath2],
      limit: 10,
      issues: []
    })

    expect(candidates).toHaveLength(2)
    expect(candidates[0].file.path).toContain('newer-sess')
    expect(candidates[1].file.path).toContain('older-sess')
  })

  it('deduplicates legacy JSON files against SQLite sessions beyond the limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-limit-dedup-'))
    cleanupDirs.push(root)
    const roots = isolatedScanRoots(root)

    const dbPath = join(root, 'state.db')
    const db = createTestDb(dbPath)

    db.prepare(
      `INSERT INTO sessions (id, updated_at) VALUES ('sess-newer', '2026-07-02T10:00:00Z')`
    ).run()
    db.prepare(
      `INSERT INTO messages (session_id, role, content) VALUES ('sess-newer', 'user', 'msg')`
    ).run()

    db.prepare(
      `INSERT INTO sessions (id, updated_at) VALUES ('sess-older', '2026-07-01T10:00:00Z')`
    ).run()
    db.prepare(
      `INSERT INTO messages (session_id, role, content) VALUES ('sess-older', 'user', 'msg')`
    ).run()
    db.close()

    await mkdir(roots.hermesSessionsDir, { recursive: true })
    await writeFile(
      join(roots.hermesSessionsDir, 'session_sess-older.json'),
      JSON.stringify({
        session_id: 'sess-older',
        messages: [{ role: 'user', content: 'Legacy duplicate' }]
      })
    )

    const scanResult = await scanAiVaultSessions({
      ...roots,
      hermesStateDbPaths: [dbPath],
      platform: 'darwin',
      limit: 1 // limit is 1, so only sess-newer is in SQLite candidate list
    })

    const hermesSessions = scanResult.sessions.filter((s) => s.agent === 'hermes')
    // sess-older should be deduplicated out even though it's beyond the candidate limit of 1
    const olderLegacy = hermesSessions.find((s) => s.sessionId === 'sess-older')
    expect(olderLegacy).toBeUndefined()
  })
})
