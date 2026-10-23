import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import { HERMES_SCHEMA_31 } from './session-scanner-hermes-sqlite-fixtures'
import {
  captureHermesSqliteSession,
  listHermesSqliteSessionIds,
  listHermesSqliteSessions,
  parseHermesSqliteSession
} from './session-scanner-hermes-sqlite'
import {
  buildHermesSqliteCandidatePath,
  splitHermesSqliteCandidate
} from './session-scanner-hermes-sqlite-paths'
import { withFullFirstUserPromptCapture } from './session-scanner-first-user-prompt-capture'
import { OPENCODE_CAPTURE_RECORD_LIMIT } from './opencode-transcript-capture-limits'

const dirs: string[] = []
const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-hermes-sqlite-'))
  dirs.push(dir)
  const path = join(dir, 'state.db')
  const db = new Database(path)
  databases.push(db)
  db.exec(HERMES_SCHEMA_31)
  db.exec('CREATE INDEX idx_messages_session_id ON messages(session_id, id)')
  return { db, path }
}
function session(db: Database.Database, id: string, activity = 1800000010, cwd = '/workspace') {
  db.prepare(
    'INSERT INTO sessions (id, source, started_at, ended_at, last_activity_at, cwd, title, model) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, 'cli', 1800000000, activity - 1, activity, cwd, `Title ${id}`, 'hermes-model')
}
function message(db: Database.Database, id: string, role: string, content: string | null) {
  db.prepare('INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(
    id,
    role,
    content,
    1800000001
  )
}
function readArgs(path: string, sessionId = 'session') {
  return { dbPath: path, sessionId, platform: 'linux' as const }
}

describe('Hermes SQLite history', () => {
  it('reads uncheckpointed live WAL sessions without changing the database', async () => {
    const { db, path } = fixture()
    db.pragma('journal_mode = WAL')
    db.pragma('wal_autocheckpoint = 0')
    session(db, 'session')
    message(db, 'session', 'user', 'First prompt')
    message(db, 'session', 'assistant', 'Assistant response')
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0)
    const before = statSync(`${path}-wal`)
    const issues: AiVaultScanIssue[] = []
    const candidates = await listHermesSqliteSessions({ dbPaths: [path], limit: 10, issues })
    expect(issues).toEqual([])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.file.mtimeMs).toBe(1800000010000)
    const parsed = await parseHermesSqliteSession(readArgs(path))
    expect(parsed).toMatchObject({
      sessionId: 'session',
      title: 'Title session',
      cwd: '/workspace',
      model: 'hermes-model',
      messageCount: 2,
      createdAt: '2027-01-15T08:00:00.000Z',
      updatedAt: '2027-01-15T08:00:10.000Z'
    })
    expect(parsed?.previewMessages.map((row) => row.text)).toEqual([
      'First prompt',
      'Assistant response'
    ])
    expect(statSync(`${path}-wal`).size).toBe(before.size)
    expect(statSync(`${path}-wal`).mtimeMs).toBe(before.mtimeMs)
    db.prepare(
      "INSERT INTO sessions(id, source, started_at) VALUES ('still-writable', 'cli', 1)"
    ).run()
  })

  it('keeps independent store identities and safely round trips delimiters and Windows paths', async () => {
    const first = fixture(),
      second = fixture()
    for (const { db } of [first, second]) {
      session(db, 'same#id%')
      message(db, 'same#id%', 'user', 'Prompt')
    }
    const rows = await listHermesSqliteSessions({
      dbPaths: [first.path, second.path, first.path],
      limit: 1,
      issues: []
    })
    expect(rows).toHaveLength(2)
    const left = await parseHermesSqliteSession(readArgs(first.path, 'same#id%'))
    const right = await parseHermesSqliteSession(readArgs(second.path, 'same#id%'))
    expect(left?.id).not.toBe(right?.id)
    expect(left?.filePath).toBe(buildHermesSqliteCandidatePath(first.path, 'same#id%'))
    expect(splitHermesSqliteCandidate(rows[0]!.file.path)?.sessionId).toBe('same#id%')
    const windows = 'C:\\Hermes # data\\state.db'
    expect(splitHermesSqliteCandidate(buildHermesSqliteCandidatePath(windows, 'same#id%'))).toEqual(
      { dbPath: windows, sessionId: 'same#id%' }
    )
    expect(splitHermesSqliteCandidate('/data/session.json#session')).toBeNull()
  })

  it('excludes empty, hidden and archived sessions and filters scope before limiting', async () => {
    const { db, path } = fixture()
    for (const id of ['empty', 'hidden', 'archived', 'outside', 'inside', 'rewound']) {
      session(
        db,
        id,
        id === 'inside' ? 1800000001 : 1800000010,
        id === 'inside' ? '/workspace/child' : '/different'
      )
    }
    for (const id of ['hidden', 'archived', 'outside', 'inside', 'rewound']) {
      message(db, id, 'user', id)
    }
    db.exec(
      "UPDATE sessions SET hidden=1 WHERE id='hidden'; UPDATE sessions SET archived=1 WHERE id='archived'; UPDATE messages SET active=0 WHERE session_id='rewound'"
    )
    const rows = await listHermesSqliteSessions({
      dbPaths: [path],
      limit: 1,
      scopePaths: ['/workspace'],
      issues: []
    })
    expect(rows.map((row) => splitHermesSqliteCandidate(row.file.path)?.sessionId)).toEqual([
      'inside'
    ])
    const all = await listHermesSqliteSessions({ dbPaths: [path], limit: Infinity, issues: [] })
    expect(all.map((row) => splitHermesSqliteCandidate(row.file.path)?.sessionId)).toEqual([
      'outside',
      'inside'
    ])
  })

  it('recognizes requested legacy IDs beyond the list cap without resurrecting hidden history', async () => {
    const { db, path } = fixture()
    for (const id of ['old', 'new', 'hidden', 'archived', 'empty']) {
      session(db, id, id === 'old' ? 1800000001 : 1800000010)
      if (id !== 'empty') {
        message(db, id, 'user', id)
      }
    }
    db.exec(
      "UPDATE sessions SET hidden=1 WHERE id='hidden'; UPDATE sessions SET archived=1 WHERE id='archived'"
    )
    const recent = await listHermesSqliteSessions({ dbPaths: [path], limit: 1, issues: [] })
    expect(recent.map((row) => splitHermesSqliteCandidate(row.file.path)?.sessionId)).toEqual([
      'new'
    ])
    const supplied = [
      ...Array.from({ length: 1001 }, (_, index) => `missing-${index}`),
      'old',
      'hidden',
      'archived',
      'empty'
    ]
    expect(listHermesSqliteSessionIds([path], supplied).sort()).toEqual([
      'archived',
      'hidden',
      'old'
    ])
    expect(listHermesSqliteSessionIds([path], [])).toEqual([])
  })

  it('handles older schema without optional visibility or recency columns', async () => {
    const { db, path } = fixture()
    db.exec(
      'DROP TABLE messages; DROP TABLE sessions; CREATE TABLE sessions(id TEXT PRIMARY KEY, started_at REAL NOT NULL, ended_at REAL, model TEXT, cwd TEXT); CREATE TABLE messages(id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL)'
    )
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?)').run(
      'old',
      1800000000,
      1800000002,
      'old-model',
      '/folder'
    )
    message(db, 'old', 'user', 'Old prompt')
    const rows = await listHermesSqliteSessions({ dbPaths: [path], limit: 10, issues: [] })
    expect(rows[0]?.file.mtimeMs).toBe(1800000002000)
    expect(await parseHermesSqliteSession(readArgs(path, 'old'))).toMatchObject({
      title: 'Old prompt',
      model: 'old-model',
      cwd: '/folder',
      messageCount: 1
    })
  })

  it('caps ordinary previews and retrieves the earliest prompt on demand', async () => {
    const { db, path } = fixture()
    session(db, 'session')
    message(db, 'session', 'user', 'First prompt '.repeat(100))
    for (let index = 0; index < 20; index++) {
      message(db, 'session', 'assistant', `Reply ${index}`)
    }
    const parsed = await parseHermesSqliteSession(readArgs(path))
    expect(parsed?.messageCount).toBe(21)
    expect(parsed?.previewMessages.map((row) => row.text)).toEqual([
      'Reply 15',
      'Reply 16',
      'Reply 17',
      'Reply 18',
      'Reply 19'
    ])
    expect(parsed?.previewMessagesTruncated).toBe(true)
    const full = await withFullFirstUserPromptCapture(() =>
      parseHermesSqliteSession(readArgs(path))
    )
    expect(full?.firstUserPrompt).toBe('First prompt '.repeat(100).trim())
    expect((await captureHermesSqliteSession(readArgs(path))).messages).toHaveLength(21)
  })

  it('copies a large structured first prompt using the canonical text safety bound', async () => {
    const { db, path } = fixture()
    session(db, 'session')
    const prompt = 'z'.repeat(300 * 1024)
    message(db, 'session', 'user', `\0json:${JSON.stringify([{ type: 'text', text: prompt }])}`)
    const full = await withFullFirstUserPromptCapture(() =>
      parseHermesSqliteSession(readArgs(path))
    )
    expect(full?.firstUserPrompt).toBe(prompt.slice(0, 256 * 1024))
  })

  it('decodes authentic structured content and tool calls through canonical sinks', async () => {
    const { db, path } = fixture()
    session(db, 'session')
    message(db, 'session', 'system', 'System context')
    message(
      db,
      'session',
      'user',
      `\0json:${JSON.stringify([{ type: 'text', text: 'Structured prompt' }])}`
    )
    message(db, 'session', 'assistant', 'Running command')
    db.prepare('UPDATE messages SET tool_calls=? WHERE role=?').run(
      JSON.stringify([
        {
          id: 'call',
          type: 'function',
          function: { name: 'terminal', arguments: JSON.stringify({ command: 'rg history' }) }
        }
      ]),
      'assistant'
    )
    message(db, 'session', 'tool', 'Tool response')
    message(db, 'session', 'unknown-upstream-role', 'Unknown text')
    message(db, 'session', 'user', '[literal JSON text]')
    const parsed = await parseHermesSqliteSession(readArgs(path))
    expect(parsed?.previewMessages.map((row) => row.text)).toContain('Structured prompt')
    const captured = await captureHermesSqliteSession(readArgs(path))
    expect(captured.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'Structured prompt' },
      { role: 'assistant', text: 'Running command' },
      { role: 'tool', text: 'terminal: rg history' },
      { role: 'tool', text: 'Tool response' },
      { role: 'user', text: '[literal JSON text]' }
    ])
    expect(captured.session?.previewMessages.some((row) => row.role === 'system')).toBe(false)
  })

  it('keeps compacted display history, suppresses rewind/scaffolding and chooses the current display row', async () => {
    const { db, path } = fixture()
    session(db, 'session')
    for (const text of [
      'compacted',
      'rewound',
      'hidden',
      'old representation',
      'current representation'
    ]) {
      message(db, 'session', 'assistant', text)
    }
    db.exec(
      "UPDATE messages SET active=0, compacted=1 WHERE content IN ('compacted', 'old representation'); UPDATE messages SET active=0 WHERE content='rewound'; UPDATE messages SET display_kind='hidden' WHERE content='hidden'; UPDATE messages SET display_order=4 WHERE content IN ('old representation', 'current representation')"
    )
    expect(
      (await captureHermesSqliteSession(readArgs(path))).messages.map((row) => row.text)
    ).toEqual(['compacted', 'current representation'])
  })

  it('reports database failures and propagates capture limits instead of returning a complete prefix', async () => {
    const { db, path } = fixture()
    session(db, 'session')
    db.exec(
      `WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < ${OPENCODE_CAPTURE_RECORD_LIMIT + 1}) INSERT INTO messages(session_id,role,content,timestamp) SELECT 'session','assistant','message',1800000001 FROM numbers`
    )
    await expect(captureHermesSqliteSession(readArgs(path))).rejects.toThrow('capture record limit')
    expect(await parseHermesSqliteSession(readArgs(path, 'missing'))).toBeNull()
    const issues: AiVaultScanIssue[] = []
    expect(
      await listHermesSqliteSessions({ dbPaths: [join(path, 'missing')], limit: 10, issues })
    ).toEqual([])
    expect(issues).toEqual([
      expect.objectContaining({ agent: 'hermes', kind: 'scope', path: join(path, 'missing') })
    ])
    expect((await parseHermesSqliteSession(readArgs(path)))?.previewMessages).toHaveLength(5)
  })
})
