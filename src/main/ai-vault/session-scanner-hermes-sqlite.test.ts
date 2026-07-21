import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from '../sqlite/sync-database'
import { scanAiVaultSessions } from './session-scanner'
import { isolatedScanRoots } from './session-scanner-test-fixtures'
import {
  listHermesSqliteSessions,
  openHermesReadonlyDatabase
} from './session-scanner-hermes-sqlite-list'
import { parseHermesSqliteSession } from './session-scanner-hermes-sqlite'
import { canonicalizeCandidates } from './session-scanner-hermes-canonicalization'
import {
  buildHermesSqliteCandidatePath,
  splitHermesSqliteCandidate
} from './session-scanner-hermes-sqlite-paths'
import type { SessionFileCandidate } from './session-scanner-types'

// Source-level scanner integration tests mock only the production worker boundary;
// direct SQLite behavior is covered below without bypassing production worker use.
vi.mock('./session-scanner-opencode-sqlite-worker-spawn', async () => {
  const [{ listHermesSqliteSessions }, { parseHermesSqliteSession }] = await Promise.all([
    import('./session-scanner-hermes-sqlite-list'),
    import('./session-scanner-hermes-sqlite')
  ])
  return {
    listOpenCodeSqliteSessionsViaWorker: vi.fn(async () => []),
    parseOpenCodeSqliteSessionViaWorker: vi.fn(async () => null),
    listHermesSqliteSessionsViaWorker: listHermesSqliteSessions,
    parseHermesSqliteSessionViaWorker: parseHermesSqliteSession
  }
})

let tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

type HermesFixtureRow = {
  id: string
  startedAt: number
  endedAt: number | null
  title: string
  cwd: string
  model: string
  messageCount?: number
  source?: string
  parentSessionId?: string | null
  endReason?: string | null
  modelConfig?: string | null
}

function createHermesStateDb(
  rows: HermesFixtureRow[] = [
    {
      id: 'hermes-db-only',
      startedAt: 1_784_000_000_000,
      endedAt: 1_784_000_060_000,
      title: 'Native Hermes history',
      cwd: '/repo/hermes',
      model: 'claude-sonnet',
      messageCount: 4
    }
  ],
  requestedDbPath?: string
): string {
  const dir = requestedDbPath
    ? dirname(requestedDbPath)
    : mkdtempSync(join(tmpdir(), 'orca-hermes-state-db-'))
  if (requestedDbPath) {
    mkdirSync(dir, { recursive: true })
  } else {
    tempDirs.push(dir)
  }
  const dbPath = requestedDbPath ?? join(dir, 'state.db')
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      model TEXT,
      started_at REAL NOT NULL,
      ended_at REAL,
      end_reason TEXT,
      parent_session_id TEXT,
      model_config TEXT,
      archived INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      reasoning_tokens INTEGER DEFAULT 0,
      cwd TEXT,
      title TEXT,
      git_branch TEXT,
      git_repo_root TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      timestamp REAL NOT NULL
    );
  `)
  const insert = db.prepare(`
    INSERT INTO sessions (
      id, source, model, started_at, ended_at, end_reason, parent_session_id, model_config, message_count,
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
      reasoning_tokens, cwd, title, git_branch, git_repo_root
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  for (const row of rows) {
    insert.run(
      row.id,
      row.source ?? 'tui',
      row.model,
      row.startedAt,
      row.endedAt,
      row.endReason ?? null,
      row.parentSessionId ?? null,
      row.modelConfig ?? null,
      row.messageCount ?? 4,
      100,
      40,
      10,
      5,
      7,
      row.cwd,
      row.title,
      'feature/hermes-history',
      '/repo'
    )
  }
  db.close()
  return dbPath
}

describe('scanAiVaultSessions Hermes state.db history', () => {
  it('discovers a state.db-only session with canonical metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-scan-'))
    tempDirs.push(root)
    const roots = isolatedScanRoots(root)
    const dbPath = createHermesStateDb()

    const result = await scanAiVaultSessions({
      ...roots,
      hermesDbPath: dbPath,
      platform: 'linux'
    })

    expect(result.issues).toEqual([])
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      agent: 'hermes',
      sessionId: 'hermes-db-only',
      title: 'Native Hermes history',
      model: 'claude-sonnet',
      cwd: '/repo/hermes',
      branch: 'feature/hermes-history',
      createdAt: new Date(1_784_000_000_000).toISOString(),
      updatedAt: new Date(1_784_000_060_000).toISOString(),
      messageCount: 4,
      totalTokens: 162,
      filePath: dbPath
    })
    expect(result.sessions[0]?.previewMessages).toEqual([])
  })

  it('lists newest SQLite candidates with a limit and parses canonical metadata directly', async () => {
    const dbPath = createHermesStateDb([
      {
        id: 'oldest',
        startedAt: 1_780_000_000_000,
        endedAt: 1_780_000_001_000,
        title: 'Oldest',
        cwd: '/repo/oldest',
        model: 'model-old'
      },
      {
        id: 'newest',
        startedAt: 1_790_000_000_000,
        endedAt: 1_790_000_005_000,
        title: 'Newest',
        cwd: '/repo/newest',
        model: 'model-new',
        messageCount: 9
      },
      {
        id: 'middle',
        startedAt: 1_785_000_000_000,
        endedAt: 1_785_000_002_000,
        title: 'Middle',
        cwd: '/repo/middle',
        model: 'model-middle'
      }
    ])
    const issues: { agent: 'hermes'; path: string; message: string }[] = []
    const candidates = await listHermesSqliteSessions({ dbPaths: [dbPath], limit: 2, issues })

    expect(issues).toEqual([])
    expect(candidates).toHaveLength(2)
    expect(
      candidates.map((candidate) => splitHermesSqliteCandidate(candidate.file.path)?.sessionId)
    ).toEqual(['newest', 'middle'])

    const session = await parseHermesSqliteSession({
      dbPath,
      sessionId: 'newest',
      platform: 'linux'
    })
    expect(session).toMatchObject({
      agent: 'hermes',
      storage: 'sqlite',
      sessionId: 'newest',
      title: 'Newest',
      cwd: '/repo/newest',
      model: 'model-new',
      messageCount: 9,
      totalTokens: 162,
      filePath: dbPath
    })
  })

  it('rejects a SQLite row whose session id becomes empty after trimming', async () => {
    const dbPath = createHermesStateDb([
      {
        id: '   ',
        startedAt: 1_790_000_000_000,
        endedAt: 1_790_000_001_000,
        title: 'Invalid empty id',
        cwd: '/repo/invalid',
        model: 'model'
      }
    ])

    const session = await parseHermesSqliteSession({
      dbPath,
      sessionId: '   ',
      platform: 'linux'
    })

    expect(session).toBeNull()
  })

  it('deduplicates mixed-case Windows legacy and SQLite session ids without changing the id', () => {
    const sqlitePath = buildHermesSqliteCandidatePath(
      'C:\\Users\\Dev\\.hermes\\state.db',
      'MixedCaseSession'
    )
    const candidates: SessionFileCandidate[] = [
      {
        agent: 'hermes',
        file: {
          path: 'C:\\Users\\Dev\\.hermes\\sessions\\session_MixedCaseSession.json',
          mtimeMs: 10,
          modifiedAt: new Date(10).toISOString()
        },
        profileName: 'default',
        codexHome: null
      },
      {
        agent: 'hermes',
        file: {
          path: sqlitePath,
          mtimeMs: 5,
          modifiedAt: new Date(5).toISOString()
        },
        profileName: 'default',
        codexHome: null
      }
    ]

    const canonical = canonicalizeCandidates(candidates)

    expect(canonical).toHaveLength(1)
    expect(canonical[0]?.file.path).toBe(sqlitePath)
    expect(splitHermesSqliteCandidate(canonical[0]!.file.path)?.sessionId).toBe('MixedCaseSession')
  })

  it('isolates malformed model_config to its row while valid history remains visible', async () => {
    const dbPath = createHermesStateDb([
      {
        id: 'malformed-config',
        startedAt: 1_790_000_000_000,
        endedAt: 1_790_000_001_000,
        title: 'Malformed config',
        cwd: '/repo/malformed',
        model: 'model',
        modelConfig: '{bad'
      },
      {
        id: 'valid-config',
        startedAt: 1_789_000_000_000,
        endedAt: 1_789_000_001_000,
        title: 'Valid config',
        cwd: '/repo/valid',
        model: 'model',
        modelConfig: JSON.stringify({ temperature: 0.2 })
      }
    ])
    const issues: { agent: 'hermes'; path: string; message: string }[] = []

    const candidates = await listHermesSqliteSessions({ dbPaths: [dbPath], limit: 20, issues })

    expect(issues).toEqual([])
    expect(
      candidates.map((candidate) => splitHermesSqliteCandidate(candidate.file.path)?.sessionId)
    ).toEqual(['malformed-config', 'valid-config'])
  })

  it('opens Hermes SQLite read-only with query_only enabled', () => {
    const dbPath = createHermesStateDb()
    const db = openHermesReadonlyDatabase(dbPath)
    try {
      expect(db.pragma('query_only', { simple: true })).toBe(1)
      expect(() => db.exec("UPDATE sessions SET title = 'mutated'")).toThrow()
    } finally {
      db.close()
    }
  })

  it('prefers SQLite before the global limit even when legacy JSON is newer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-limit-'))
    tempDirs.push(root)
    const roots = isolatedScanRoots(root)
    const hermesSessionsDir = join(root, 'sessions')
    mkdirSync(hermesSessionsDir, { recursive: true })
    writeFileSync(
      join(hermesSessionsDir, 'session_shared.json'),
      JSON.stringify({
        session_id: 'shared',
        model: 'legacy-model',
        cwd: '/legacy',
        session_start: '2030-01-01T10:00:00.000Z',
        last_updated: '2030-01-01T10:01:00.000Z',
        messages: [{ role: 'user', content: 'legacy' }]
      })
    )
    const dbPath = createHermesStateDb(
      [
        {
          id: 'shared',
          startedAt: 1_784_000_000_000,
          endedAt: 1_784_000_060_000,
          title: 'SQLite canonical',
          cwd: '/db',
          model: 'db-model'
        }
      ],
      join(root, 'state.db')
    )

    const result = await scanAiVaultSessions({
      ...roots,
      hermesDbPath: dbPath,
      hermesSessionsDir,
      limit: 1,
      platform: 'linux'
    })

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({ storage: 'sqlite', title: 'SQLite canonical' })
  })

  it('fills the global limit with the next unique session after cross-source canonicalization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-canonical-limit-'))
    tempDirs.push(root)
    const roots = isolatedScanRoots(root)
    const hermesSessionsDir = join(root, 'sessions')
    mkdirSync(hermesSessionsDir, { recursive: true })
    writeFileSync(
      join(hermesSessionsDir, 'session_shared.json'),
      JSON.stringify({
        session_id: 'shared',
        model: 'legacy-model',
        cwd: '/legacy',
        session_start: '2030-01-01T10:00:00.000Z',
        last_updated: '2030-01-01T10:01:00.000Z',
        messages: [{ role: 'user', content: 'legacy' }]
      })
    )
    const dbPath = createHermesStateDb(
      [
        {
          id: 'shared',
          startedAt: 1_790_000_000_000,
          endedAt: 1_790_000_001_000,
          title: 'SQLite canonical',
          cwd: '/db',
          model: 'db-model'
        },
        {
          id: 'unique',
          startedAt: 1_789_000_000_000,
          endedAt: 1_789_000_001_000,
          title: 'SQLite unique',
          cwd: '/unique',
          model: 'unique-model'
        }
      ],
      join(root, 'state.db')
    )

    const result = await scanAiVaultSessions({
      ...roots,
      hermesDbPath: dbPath,
      hermesSessionsDir,
      limit: 2,
      limitPerAgent: 1,
      platform: 'linux'
    })

    expect(result.sessions.map((session) => session.sessionId)).toEqual(['shared', 'unique'])
    expect(result.sessions[0]).toMatchObject({ storage: 'sqlite', title: 'SQLite canonical' })
  })

  it('keeps same-id sessions from independent default Hermes stores and fills the cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-independent-stores-'))
    tempDirs.push(root)
    const roots = isolatedScanRoots(root)
    const dbA = createHermesStateDb(
      [
        {
          id: 'shared',
          startedAt: 1_790_000_000_000,
          endedAt: 1_790_000_001_000,
          title: 'Store A',
          cwd: '/repo/a',
          model: 'model-a'
        }
      ],
      join(root, 'store-a', 'state.db')
    )
    const dbB = createHermesStateDb(
      [
        {
          id: 'shared',
          startedAt: 1_789_000_000_000,
          endedAt: 1_789_000_001_000,
          title: 'Store B',
          cwd: '/repo/b',
          model: 'model-b'
        }
      ],
      join(root, 'store-b', 'state.db')
    )

    const result = await scanAiVaultSessions({
      ...roots,
      hermesDbPaths: [dbA, dbB],
      hermesSessionsDir: join(root, 'no-legacy-sessions'),
      limit: 2,
      platform: 'linux'
    })

    const shared = result.sessions.filter(
      (session) => session.agent === 'hermes' && session.sessionId === 'shared'
    )
    expect(shared).toHaveLength(2)
    expect(shared.map((session) => session.title).sort()).toEqual(['Store A', 'Store B'])
  })

  it('returns one bounded first-user preview without reading a message bulk', async () => {
    const dbPath = createHermesStateDb()
    const db = new Database(dbPath)
    db.prepare(
      'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)'
    ).run('hermes-db-only', 'user', 'first prompt', 1_784_000_001_000)
    db.prepare(
      'INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)'
    ).run('hermes-db-only', 'assistant', 'assistant bulk should not be surfaced', 1_784_000_002_000)
    db.close()

    const session = await parseHermesSqliteSession({
      dbPath,
      sessionId: 'hermes-db-only',
      platform: 'linux'
    })

    expect(session?.previewMessages).toEqual([
      expect.objectContaining({ role: 'user', text: 'first prompt' })
    ])
  })

  it('keeps roots and branches visible while hiding delegate, tool, and compression children', async () => {
    const dbPath = createHermesStateDb([
      {
        id: 'root',
        startedAt: 1_784_000_000_000,
        endedAt: 1_784_000_010_000,
        title: 'Root',
        cwd: '/repo/root',
        model: 'model',
        endReason: 'branched'
      },
      {
        id: 'branch',
        startedAt: 1_784_000_020_000,
        endedAt: 1_784_000_030_000,
        title: 'Branch',
        cwd: '/repo/branch',
        model: 'model',
        parentSessionId: 'root',
        modelConfig: JSON.stringify({ _branched_from: 'root' })
      },
      {
        id: 'delegate',
        startedAt: 1_784_000_040_000,
        endedAt: 1_784_000_050_000,
        title: 'Delegate',
        cwd: '/repo/delegate',
        model: 'model',
        parentSessionId: 'root',
        modelConfig: JSON.stringify({ _delegate_from: 'root' })
      },
      {
        id: 'compression-root',
        startedAt: 1_784_000_060_000,
        endedAt: 1_784_000_070_000,
        title: 'Compressed root',
        cwd: '/repo/compressed',
        model: 'model',
        endReason: 'compression'
      },
      {
        id: 'compression-tip',
        startedAt: 1_784_000_080_000,
        endedAt: 1_784_000_090_000,
        title: 'Compression tip',
        cwd: '/repo/compressed',
        model: 'model',
        parentSessionId: 'compression-root'
      },
      {
        id: 'tool-child',
        startedAt: 1_784_000_100_000,
        endedAt: 1_784_000_110_000,
        title: 'Tool child',
        cwd: '/repo/tool',
        model: 'model',
        source: 'tool',
        parentSessionId: 'root'
      }
    ])

    const issues: { agent: 'hermes'; path: string; message: string }[] = []
    const candidates = await listHermesSqliteSessions({ dbPaths: [dbPath], limit: 20, issues })
    const ids = candidates.map(
      (candidate) => splitHermesSqliteCandidate(candidate.file.path)?.sessionId
    )

    expect(issues).toEqual([])
    expect(ids).toEqual(['compression-tip', 'branch', 'root'])
  })

  it('prefers DB history over legacy JSON and keeps another agent alive', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hermes-dedupe-'))
    tempDirs.push(root)
    const roots = isolatedScanRoots(root)
    const hermesSessionsDir = join(root, 'sessions')
    mkdirSync(hermesSessionsDir, { recursive: true })
    writeFileSync(
      join(hermesSessionsDir, 'session_shared.json'),
      JSON.stringify({
        session_id: 'shared',
        model: 'legacy-model',
        cwd: '/legacy',
        session_start: '2026-06-01T10:00:00.000Z',
        last_updated: '2026-06-01T10:01:00.000Z',
        messages: [{ role: 'user', content: 'Legacy title' }]
      })
    )
    mkdirSync(join(roots.claudeProjectsDir, 'project'), { recursive: true })
    writeFileSync(
      join(roots.claudeProjectsDir, 'project', 'survivor.jsonl'),
      [
        {
          type: 'user',
          sessionId: 'claude-survivor',
          timestamp: '2026-06-02T10:00:00.000Z',
          cwd: '/repo/survivor',
          message: { role: 'user', content: 'Other agent survives' }
        },
        {
          type: 'assistant',
          sessionId: 'claude-survivor',
          timestamp: '2026-06-02T10:00:01.000Z',
          message: { role: 'assistant', content: 'Done' }
        }
      ]
        .map((record) => JSON.stringify(record))
        .join('\n')
    )
    const dbPath = createHermesStateDb(
      [
        {
          id: 'shared',
          startedAt: 1_784_000_000_000,
          endedAt: 1_784_000_060_000,
          title: 'DB title wins',
          cwd: '/db',
          model: 'db-model'
        }
      ],
      join(root, 'state.db')
    )

    const result = await scanAiVaultSessions({
      ...roots,
      hermesDbPath: dbPath,
      hermesSessionsDir,
      platform: 'linux'
    })
    const shared = result.sessions.filter(
      (session) => session.agent === 'hermes' && session.sessionId === 'shared'
    )
    expect(result.issues).toEqual([])
    expect(shared).toHaveLength(1)
    expect(shared[0]).toMatchObject({ storage: 'sqlite', title: 'DB title wins', cwd: '/db' })
    expect(result.sessions.some((session) => session.sessionId === 'claude-survivor')).toBe(true)
  })

  it.each([
    ['missing', 'missing state.db', (path: string) => path],
    [
      'corrupt',
      'corrupt state.db',
      (path: string) => {
        writeFileSync(path, 'not sqlite')
        return path
      }
    ],
    [
      'incompatible',
      'incompatible state.db',
      (path: string) => {
        const db = new Database(path)
        db.exec('CREATE TABLE unrelated (id TEXT PRIMARY KEY)')
        db.close()
        return path
      }
    ]
  ])(
    'bounds a %s DB issue while legacy and another agent survive',
    async (_kind, _label, prepareDb) => {
      const root = mkdtempSync(join(tmpdir(), 'orca-hermes-db-issue-'))
      tempDirs.push(root)
      const roots = isolatedScanRoots(root)
      mkdirSync(roots.hermesSessionsDir, { recursive: true })
      writeFileSync(
        join(roots.hermesSessionsDir, 'session_legacy.json'),
        JSON.stringify({
          session_id: 'legacy-survivor',
          cwd: '/legacy',
          session_start: '2026-06-03T10:00:00.000Z',
          last_updated: '2026-06-03T10:01:00.000Z',
          messages: [{ role: 'user', content: 'Legacy survives' }]
        })
      )
      mkdirSync(join(roots.claudeProjectsDir, 'project'), { recursive: true })
      writeFileSync(
        join(roots.claudeProjectsDir, 'project', 'survivor.jsonl'),
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-survivor',
          timestamp: '2026-06-03T10:02:00.000Z',
          cwd: '/repo',
          message: { role: 'user', content: 'Other agent survives' }
        })
      )
      const dbPath = prepareDb(join(root, 'state.db'))
      const result = await scanAiVaultSessions({
        ...roots,
        hermesDbPath: dbPath,
        platform: 'linux'
      })

      expect(result.sessions.some((session) => session.sessionId === 'legacy-survivor')).toBe(true)
      expect(result.sessions.some((session) => session.sessionId === 'claude-survivor')).toBe(true)
      expect(result.issues.filter((issue) => issue.agent === 'hermes')).toHaveLength(1)
    }
  )
})
