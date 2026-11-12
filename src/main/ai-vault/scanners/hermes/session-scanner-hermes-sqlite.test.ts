import '../../../foreign-sqlite-readers/foreign-sqlite-reader.test-fixture'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultScanIssue } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import SyncDatabase from '../../../sqlite/sync-database'
import { listHermesSqliteSessions, parseHermesSqliteSession } from './session-scanner-hermes-sqlite'
import { buildHermesSqliteCandidatePath } from './session-scanner-hermes-sqlite-paths'
import { scanAiVaultSessions } from '../../session-scanner'
import { isolatedScanRoots } from '../../session-scanner-test-fixtures'
import { parseAgentSessionFile } from '../../session-scanner-agent-parser'
import { readAiVaultFirstUserPrompt } from '../../session-first-user-prompt-read'
import type { SessionFileCandidate } from '../../session-scanner-types'
import { readWholeTranscript } from '../../transcripts/session-transcript-reader'
import {
  registerTranscriptConsumer,
  resetTranscriptConsumersForTests,
  type TranscriptMessage
} from '../../transcripts/session-transcript-consumers'

describe('Hermes SQLite support', () => {
  const cleanupDirs: string[] = []

  afterEach(() => {
    resetTranscriptConsumersForTests()
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
    expect(
      await parseHermesSqliteSession({ dbPath, sessionId: 'missing-session', platform: 'darwin' })
    ).toBeNull()
  })

  it.each(['sqlite', 'json'])(
    'publishes full %s messages without changing the session',
    async (format) => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-hermes-consumer-'))
      cleanupDirs.push(dir)
      const messages = Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `Turn ${index}: ${'x'.repeat(400)}`
      }))
      const sessionId = 'hermes-consumer'
      const modifiedAt = '2026-06-01T10:00:00.000Z'
      let filePath: string
      if (format === 'sqlite') {
        const dbPath = join(dir, 'state.db')
        const db = createTestDb(dbPath)
        db.prepare('INSERT INTO sessions (id, created_at, updated_at) VALUES (?, ?, ?)').run(
          sessionId,
          modifiedAt,
          modifiedAt
        )
        const insertMessage = db.prepare(
          'INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)'
        )
        for (const message of messages) {
          insertMessage.run(sessionId, message.role, message.content)
        }
        db.close()
        filePath = buildHermesSqliteCandidatePath(dbPath, sessionId)
      } else {
        filePath = join(dir, `session_${sessionId}.json`)
        await writeFile(filePath, JSON.stringify({ session_id: sessionId, messages }))
      }
      const candidate: SessionFileCandidate = {
        agent: 'hermes',
        codexHome: null,
        file: { path: filePath, mtimeMs: Date.parse(modifiedAt), modifiedAt }
      }
      const unobserved = await parseAgentSessionFile(candidate, process.platform)
      const received: TranscriptMessage[] = []
      const finish = vi.fn()
      registerTranscriptConsumer({
        beginRead: () => ({ message: (message) => received.push(message), finish })
      })

      const session = await readWholeTranscript({ candidate, platform: process.platform })

      expect(session).toEqual(unobserved)
      expect(session?.messageCount).toBe(8)
      expect(session?.previewMessages).toHaveLength(5)
      expect(received).toEqual(
        messages.map((message) => ({ role: message.role, text: message.content, timestamp: null }))
      )
      expect(finish).toHaveBeenCalledExactlyOnceWith({ session, byteOffset: 0, incomplete: false })
    }
  )

  it('reports a corrupt SQLite database read as incomplete', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-hermes-read-error-'))
    cleanupDirs.push(dir)
    const dbPath = join(dir, 'state.db')
    await writeFile(dbPath, 'not a SQLite database')
    const finish = vi.fn()
    const message = vi.fn()
    registerTranscriptConsumer({ beginRead: () => ({ message, finish }) })

    await expect(
      readWholeTranscript({
        candidate: {
          agent: 'hermes',
          codexHome: null,
          file: {
            path: buildHermesSqliteCandidatePath(dbPath, 'hermes-read-error'),
            mtimeMs: 1,
            modifiedAt: new Date(1).toISOString()
          }
        },
        platform: process.platform
      })
    ).rejects.toThrow('file is not a database')

    expect(message).not.toHaveBeenCalled()
    expect(finish).toHaveBeenCalledExactlyOnceWith({
      session: null,
      byteOffset: 0,
      incomplete: true,
      cancelled: false
    })
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

    const unlimitedResult = await scanAiVaultSessions({
      ...roots,
      hermesStateDbPaths: [dbPath],
      platform: 'darwin',
      limit: 1,
      unlimited: true
    })
    expect(unlimitedResult.issues).toEqual([])
    expect(unlimitedResult.sessions.filter((s) => s.agent === 'hermes')).toEqual(hermesSessions)
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
      limit: 10,
      limitPerAgent: 1
    })

    const hermesSessions = scanResult.sessions.filter((s) => s.agent === 'hermes')
    // sess-older should be deduplicated out even though it's beyond the candidate limit of 1
    expect(hermesSessions.map((s) => s.sessionId)).toEqual(['sess-newer'])
  })

  // Why: the shipped schema carries none of created_at/updated_at — recency
  // lives in started_at/ended_at/last_activity_at as REAL epoch seconds.
  function createShippedSchemaDb(dbPath: string) {
    const db = new SyncDatabase(dbPath)
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT,
        cwd TEXT,
        model TEXT,
        started_at REAL NOT NULL,
        ended_at REAL,
        last_activity_at REAL
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        role TEXT,
        content TEXT,
        timestamp REAL
      );
    `)
    return db
  }

  it('dates sessions from the shipped schema instead of falling back to now', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-hermes-shipped-schema-'))
    cleanupDirs.push(dir)
    const dbPath = join(dir, 'state.db')
    const db = createShippedSchemaDb(dbPath)

    const insertSession = db.prepare(
      `INSERT INTO sessions (id, title, cwd, model, started_at, ended_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    insertSession.run('sess-activity', 'Activity', '/tmp/hermes', 'hermes-v3', 1000, null, 5000)
    insertSession.run('sess-ended', 'Ended', '/tmp/hermes', 'hermes-v3', 2000, 3000, null)
    insertSession.run('sess-started', 'Started', '/tmp/hermes', 'hermes-v3', 4000, null, null)

    const insertMessage = db.prepare(
      `INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', 'msg', ?)`
    )
    insertMessage.run('sess-activity', 1000)
    insertMessage.run('sess-ended', 2000)
    insertMessage.run('sess-started', 4000)
    db.close()

    const issues: AiVaultScanIssue[] = []
    const candidates = await listHermesSqliteSessions({ dbPaths: [dbPath], limit: 10, issues })

    expect(issues).toEqual([])
    expect(candidates.map((c) => c.file.mtimeMs)).toEqual([5_000_000, 4_000_000, 3_000_000])

    const parsed = await parseHermesSqliteSession({
      dbPath,
      sessionId: 'sess-activity',
      platform: 'darwin'
    })
    expect(parsed?.title).toBe('Activity')
    expect(parsed?.messageCount).toBe(1)
  })

  it('keeps the legacy JSON when the migration left a message-less SQLite shell', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-shell-dedup-'))
    cleanupDirs.push(root)
    const roots = isolatedScanRoots(root)

    const dbPath = join(root, 'state.db')
    const db = createTestDb(dbPath)
    // Migrated shell: the session row came over, its turns did not.
    db.prepare(
      `INSERT INTO sessions (id, updated_at) VALUES ('sess-shell', '2026-07-01T10:00:00Z')`
    ).run()
    db.close()

    await mkdir(roots.hermesSessionsDir, { recursive: true })
    await writeFile(
      join(roots.hermesSessionsDir, 'session_sess-shell.json'),
      JSON.stringify({
        session_id: 'sess-shell',
        messages: [{ role: 'user', content: 'Turns only the JSON still has' }]
      })
    )

    const scanResult = await scanAiVaultSessions({
      ...roots,
      hermesStateDbPaths: [dbPath],
      platform: 'darwin',
      limit: 10
    })

    const shell = scanResult.sessions.find((s) => s.sessionId === 'sess-shell')
    expect(shell).toBeDefined()
    expect(shell?.messageCount).toBe(1)
  })

  it('recovers an older SQLite session in a workspace beyond the global candidate limit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-scope-'))
    cleanupDirs.push(root)
    const roots = isolatedScanRoots(root)
    const dbPath = join(root, 'state.db')
    const db = createShippedSchemaDb(dbPath)
    const workspace = join(root, 'workspace')
    const insertSession = db.prepare('INSERT INTO sessions (id, cwd, started_at) VALUES (?, ?, ?)')
    insertSession.run('target-old', workspace, 1_800_000_000)
    insertSession.run('other-new', join(root, 'other'), 1_800_000_100)
    insertSession.run('other-newest', join(root, 'other'), 1_800_000_200)
    db.exec(`INSERT INTO messages (session_id, role, content, timestamp)
      SELECT id, 'user', 'hello', started_at FROM sessions`)
    db.close()
    await mkdir(roots.hermesSessionsDir, { recursive: true })
    await writeFile(
      join(roots.hermesSessionsDir, 'session_target-old.json'),
      JSON.stringify({
        session_id: 'target-old',
        cwd: workspace,
        messages: [{ role: 'user', content: 'stale JSON' }]
      })
    )

    const result = await scanAiVaultSessions({
      ...roots,
      hermesStateDbPaths: [dbPath],
      limit: 1,
      limitPerAgent: 2,
      scopePaths: [workspace]
    })

    expect(result.issues).toEqual([])
    expect(result.sessions.map((session) => session.sessionId)).toEqual([
      'other-newest',
      'target-old'
    ])
    expect(result.sessions.find((session) => session.sessionId === 'target-old')?.filePath).toBe(
      buildHermesSqliteCandidatePath(dbPath, 'target-old')
    )
  })

  it('refreshes a cached session after a message append despite an invalid timestamp', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-append-'))
    cleanupDirs.push(root)
    const dbPath = join(root, 'state.db')
    const db = createShippedSchemaDb(dbPath)
    db.exec(`
      INSERT INTO sessions (id, started_at) VALUES ('active-session', 1800000000), ('other-session', 1800000030);
      INSERT INTO messages (session_id, role, content, timestamp) VALUES
        ('active-session', 'user', 'hello', 1800000000),
        ('active-session', 'tool', 'invalid clock', 5e246),
        ('other-session', 'user', 'other question', 1800000030);
    `)
    const options = { ...isolatedScanRoots(root), hermesStateDbPaths: [dbPath], limit: 10 }
    try {
      const first = await scanAiVaultSessions(options)
      expect(first.sessions.map((session) => session.sessionId)).toEqual([
        'other-session',
        'active-session'
      ])
      expect(
        first.sessions.find((session) => session.sessionId === 'active-session')?.messageCount
      ).toBe(1)
      db.exec(`INSERT INTO messages (session_id, role, content, timestamp)
        VALUES ('active-session', 'assistant', 'new answer', 1800000060)`)

      const second = await scanAiVaultSessions(options)
      expect(second.sessions.map((session) => session.sessionId)).toEqual([
        'active-session',
        'other-session'
      ])
      expect(second.sessions[0].messageCount).toBe(2)
      expect(second.sessions[0].previewMessages.map((message) => message.text)).toEqual([
        'hello',
        'new answer'
      ])
    } finally {
      db.close()
    }
  })

  it.each(['created_at', 'timestamp'])(
    'preserves %s message ordering when the schema has no id column',
    async (timeColumn) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-hermes-message-order-'))
      cleanupDirs.push(root)
      const dbPath = join(root, 'state.db')
      const db = new SyncDatabase(dbPath)
      db.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at REAL);
        CREATE TABLE messages (session_id TEXT, role TEXT, content TEXT, ${timeColumn} REAL);
        INSERT INTO sessions (id, created_at) VALUES ('time-ordered', 1800000000);
        INSERT INTO messages (session_id, role, content, ${timeColumn}) VALUES
          ('time-ordered', 'user', 'Later question', 1800000060),
          ('time-ordered', 'user', 'Opening question', 1800000010);
      `)
      db.close()

      const parsed = await parseHermesSqliteSession({
        dbPath,
        sessionId: 'time-ordered',
        platform: 'darwin'
      })
      expect(parsed?.title).toBe('Opening question')
      expect(parsed?.previewMessages.map((message) => message.text)).toEqual([
        'Opening question',
        'Later question'
      ])
    }
  )

  it('reads the complete opening prompt in insertion order when timestamps go backward', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-first-prompt-'))
    cleanupDirs.push(root)
    const dbPath = join(root, 'state.db')
    const db = createShippedSchemaDb(dbPath)
    const prompt = `Review the complete request.\n\n${'detail '.repeat(80).trimEnd()}`
    db.exec(`INSERT INTO sessions (id, started_at) VALUES ('full-prompt', 1800000000)`)
    db.prepare(`INSERT INTO messages (session_id, role, content, timestamp)
      VALUES ('full-prompt', 'user', ?, 1800000010)`).run(prompt)
    db.exec(`INSERT INTO messages (session_id, role, content, timestamp)
      VALUES ('full-prompt', 'user', 'Later question', 1800000000)`)
    db.close()

    const result = await readAiVaultFirstUserPrompt({
      agent: 'hermes',
      sessionId: 'full-prompt',
      filePath: buildHermesSqliteCandidatePath(dbPath, 'full-prompt')
    })
    expect(result.prompt).toBe(prompt)
  })
})
