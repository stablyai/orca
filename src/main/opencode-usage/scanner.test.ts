import { mkdirSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import {
  attributeOpenCodeUsageEvent,
  parseOpenCodeUsageDatabase,
  parseOpenCodeUsageRow,
  scanOpenCodeUsageDatabases
} from './scanner'

const WORKTREE = '/workspace/repo'

let tempDirs: string[] = []

function createTempDb(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'orca-opencode-usage-'))
  tempDirs.push(dir)
  const path = join(dir, 'opencode.db')
  return { db: new Database(path), path }
}

function worktrees() {
  return [
    {
      repoId: 'repo-1',
      worktreeId: 'repo-1::/workspace/repo',
      path: WORKTREE,
      displayName: 'Repo',
      canonicalPath: WORKTREE
    }
  ]
}

function createSessionTotalsSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      directory TEXT,
      title TEXT,
      model TEXT,
      cost REAL,
      tokens_input INTEGER,
      tokens_output INTEGER,
      tokens_reasoning INTEGER,
      tokens_cache_read INTEGER,
      time_created INTEGER,
      time_updated INTEGER
    );
  `)
}

function insertSessionTotalsRow(
  db: Database.Database,
  sessionId: string,
  inputTokens: number
): void {
  db.prepare(
    `INSERT INTO session (
      id, directory, title, model, cost,
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
      time_created, time_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    sessionId,
    `${WORKTREE}/packages/app`,
    'Session',
    JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-5' }),
    0.01,
    inputTokens,
    100,
    0,
    0,
    1_777_777_700_000,
    1_777_777_800_000
  )
}

function usageEvent(cwd: string) {
  return {
    sessionId: 'session-1',
    timestamp: '2026-04-09T10:00:00.000Z',
    cwd,
    model: 'anthropic/claude-sonnet-4-5',
    estimatedCostUsd: 0.012,
    inputTokens: 100,
    cachedInputTokens: 10,
    outputTokens: 25,
    reasoningOutputTokens: 10,
    totalTokens: 125
  }
}

describe('parseOpenCodeUsageRow', () => {
  it('reads assistant message tokens, cost, model, cwd, and timestamp', () => {
    const parsed = parseOpenCodeUsageRow({
      id: 'message-1',
      session_id: 'session-1',
      time_created: 1_777_777_700_000,
      time_updated: null,
      directory: null,
      title: null,
      worktree: null,
      session_model: null,
      data: JSON.stringify({
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-5',
        path: { cwd: `${WORKTREE}/packages/app` },
        cost: 0.0123,
        tokens: {
          input: 1000,
          output: 250,
          reasoning: 100,
          total: 1350,
          cache: { read: 400, write: 25 }
        },
        time: {
          completed: 1_777_777_800_000
        }
      })
    })

    expect(parsed).toEqual({
      sessionId: 'session-1',
      timestamp: new Date(1_777_777_800_000).toISOString(),
      cwd: `${WORKTREE}/packages/app`,
      model: 'anthropic/claude-sonnet-4-5',
      estimatedCostUsd: 0.0123,
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 250,
      reasoningOutputTokens: 100,
      totalTokens: 1350
    })
  })
})

describe('attributeOpenCodeUsageEvent', () => {
  it('attributes cwd paths under dotdot-prefixed child directories to the worktree', async () => {
    const attributed = await attributeOpenCodeUsageEvent(
      usageEvent(`${WORKTREE}/..fixtures/session`),
      worktrees()
    )

    expect(attributed?.projectKey).toBe('worktree:repo-1::/workspace/repo')
    expect(attributed?.projectLabel).toBe('Repo')
    expect(attributed?.worktreeId).toBe('repo-1::/workspace/repo')
  })

  it('does not attribute true parent-directory escapes to the worktree', async () => {
    const attributed = await attributeOpenCodeUsageEvent(
      usageEvent(`${WORKTREE}/../other/session`),
      worktrees()
    )

    expect(attributed?.projectKey).toBe('cwd:/workspace/repo/../other/session')
    expect(attributed?.worktreeId).toBeNull()
  })

  it('does not treat different Windows drives as containing paths', async () => {
    const attributed = await attributeOpenCodeUsageEvent(usageEvent('D:\\other\\repo'), [
      {
        repoId: 'repo-1',
        worktreeId: 'repo-1::C:\\repo',
        path: 'C:\\repo',
        displayName: 'Repo',
        canonicalPath: 'C:\\repo'
      }
    ])

    expect(attributed?.projectKey).toBe('cwd:d:/other/repo')
    expect(attributed?.worktreeId).toBeNull()
  })
})

describe('parseOpenCodeUsageDatabase', () => {
  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tempDirs = []
  })

  it('uses materialized session token totals when the OpenCode DB has them', async () => {
    const { db, path } = createTempDb()
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        directory TEXT,
        title TEXT,
        model TEXT,
        cost REAL,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_reasoning INTEGER,
        tokens_cache_read INTEGER,
        time_created INTEGER,
        time_updated INTEGER
      );
    `)
    db.prepare('INSERT INTO project (id, worktree) VALUES (?, ?)').run('project-1', WORKTREE)
    db.prepare(
      `INSERT INTO session (
        id, project_id, directory, title, model, cost,
        tokens_input, tokens_output, tokens_reasoning, tokens_cache_read,
        time_created, time_updated
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'session-1',
      'project-1',
      `${WORKTREE}/packages/app`,
      'Build feature',
      JSON.stringify({ providerID: 'anthropic', id: 'claude-sonnet-4-5' }),
      0.06,
      1000,
      500,
      100,
      250,
      1_777_777_700_000,
      1_777_777_800_000
    )
    db.close()

    const parsed = await parseOpenCodeUsageDatabase(path, worktrees())

    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.sessions[0]).toMatchObject({
      sessionId: 'session-1',
      primaryModel: 'anthropic/claude-sonnet-4-5',
      primaryProjectLabel: 'Repo',
      eventCount: 1,
      totalInputTokens: 1000,
      totalCachedInputTokens: 250,
      totalOutputTokens: 500,
      totalReasoningOutputTokens: 100,
      totalTokens: 1600,
      estimatedCostUsd: 0.06
    })
    expect(parsed.dailyAggregates).toEqual([
      expect.objectContaining({
        projectLabel: 'Repo',
        inputTokens: 1000,
        cachedInputTokens: 250,
        outputTokens: 500,
        reasoningOutputTokens: 100,
        totalTokens: 1600,
        estimatedCostUsd: 0.06
      })
    ])
  })

  it('supports session_message tables without a type column', async () => {
    const { db, path } = createTempDb()
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT,
        title TEXT,
        time_created INTEGER,
        time_updated INTEGER
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
    `)
    db.prepare(
      'INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)'
    ).run('session-1', `${WORKTREE}/tools`, 'Legacy session', 1_777_777_700_000, 1_777_777_800_000)
    db.prepare(
      'INSERT INTO session_message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    ).run(
      'message-1',
      'session-1',
      1_777_777_700_000,
      1_777_777_800_000,
      JSON.stringify({
        providerID: 'openai',
        modelID: 'gpt-5.5',
        cost: 0.03,
        tokens: {
          input: 800,
          output: 200,
          reasoning: 50,
          cache: { read: 100, write: 0 }
        }
      })
    )
    db.close()

    const parsed = await parseOpenCodeUsageDatabase(path, worktrees())

    expect(parsed.sessions[0]).toMatchObject({
      primaryModel: 'openai/gpt-5.5',
      primaryProjectLabel: 'Repo',
      totalTokens: 1050,
      estimatedCostUsd: 0.03
    })
  })

  it('reports the session ids the database counted', async () => {
    const { db, path } = createTempDb()
    createSessionTotalsSchema(db)
    insertSessionTotalsRow(db, 'session-1', 1000)
    db.close()

    const parsed = await parseOpenCodeUsageDatabase(path, worktrees())

    expect(parsed.ownedSessionIds).toEqual(['session-1'])
  })

  it('prefers session_message rows over legacy message rows to avoid double counting', async () => {
    const { db, path } = createTempDb()
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT,
        title TEXT,
        time_created INTEGER,
        time_updated INTEGER
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        type TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        time_created INTEGER,
        time_updated INTEGER,
        data TEXT
      );
    `)
    db.prepare(
      'INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)'
    ).run('session-1', WORKTREE, 'Mixed schema session', 1_777_777_700_000, 1_777_777_800_000)
    db.prepare(
      'INSERT INTO session_message (id, session_id, type, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(
      'session-message-1',
      'session-1',
      'assistant',
      1_777_777_700_000,
      1_777_777_800_000,
      JSON.stringify({
        providerID: 'openai',
        modelID: 'gpt-5.5',
        tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 10, write: 0 } }
      })
    )
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    ).run(
      'legacy-message-1',
      'session-1',
      1_777_777_700_000,
      1_777_777_800_000,
      JSON.stringify({
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        tokens: { input: 1000, output: 500, reasoning: 0, cache: { read: 100, write: 0 } }
      })
    )
    db.close()

    const parsed = await parseOpenCodeUsageDatabase(path, worktrees())

    expect(parsed.sessions[0]?.totalTokens).toBe(120)
    expect(parsed.sessions[0]?.eventCount).toBe(1)
  })
})

describe('scanOpenCodeUsageDatabases', () => {
  let dataRoot: string
  let openCodeDir: string
  let previousXdgDataHome: string | undefined
  let previousOpenCodeDb: string | undefined

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'orca-opencode-usage-scan-'))
    openCodeDir = join(dataRoot, 'opencode')
    mkdirSync(openCodeDir, { recursive: true })
    previousXdgDataHome = process.env.XDG_DATA_HOME
    previousOpenCodeDb = process.env.OPENCODE_DB
    process.env.XDG_DATA_HOME = dataRoot
    delete process.env.OPENCODE_DB
  })

  afterEach(() => {
    if (previousXdgDataHome === undefined) {
      delete process.env.XDG_DATA_HOME
    } else {
      process.env.XDG_DATA_HOME = previousXdgDataHome
    }
    if (previousOpenCodeDb === undefined) {
      delete process.env.OPENCODE_DB
    } else {
      process.env.OPENCODE_DB = previousOpenCodeDb
    }
    rmSync(dataRoot, { recursive: true, force: true })
  })

  function writeSessionTotalsDb(fileName: string, rows: [string, number][]): string {
    const path = join(openCodeDir, fileName)
    const db = new Database(path)
    createSessionTotalsSchema(db)
    for (const [sessionId, inputTokens] of rows) {
      insertSessionTotalsRow(db, sessionId, inputTokens)
    }
    db.close()
    return path
  }

  it('counts a session duplicated into a stale backup database exactly once', async () => {
    // The backup holds a stale snapshot of session-1; the canonical db has
    // grown since. The canonical totals must win and be counted once.
    writeSessionTotalsDb('opencode.db', [
      ['session-1', 1000],
      ['session-2', 300]
    ])
    writeSessionTotalsDb('opencode-backup.db', [['session-1', 400]])

    const result = await scanOpenCodeUsageDatabases([], [])

    expect(result.sessions).toHaveLength(2)
    const sessionOne = result.sessions.find((session) => session.sessionId === 'session-1')
    expect(sessionOne?.totalInputTokens).toBe(1000)
    expect(sessionOne?.eventCount).toBe(1)
    expect(
      result.dailyAggregates.reduce((total, aggregate) => total + aggregate.inputTokens, 0)
    ).toBe(1300)
  })

  it('still counts backup-only sessions and stays stable across cached rescans', async () => {
    const canonicalPath = writeSessionTotalsDb('opencode.db', [['session-1', 1000]])
    // The backup duplicates session-1 (stale) and preserves session-9, which
    // no longer exists in the canonical database.
    writeSessionTotalsDb('opencode-backup.db', [
      ['session-1', 400],
      ['session-9', 50]
    ])

    const first = await scanOpenCodeUsageDatabases([], [])
    expect(
      first.dailyAggregates.reduce((total, aggregate) => total + aggregate.inputTokens, 0)
    ).toBe(1050)

    const second = await scanOpenCodeUsageDatabases([], first.processedDatabases)
    expect(
      second.dailyAggregates.reduce((total, aggregate) => total + aggregate.inputTokens, 0)
    ).toBe(1050)

    // The canonical db keeps growing while the backup stays cached; session-1
    // must stay owned by the canonical db.
    const db = new Database(canonicalPath)
    insertSessionTotalsRow(db, 'session-2', 200)
    db.close()

    const third = await scanOpenCodeUsageDatabases([], second.processedDatabases)
    expect(
      third.dailyAggregates.reduce((total, aggregate) => total + aggregate.inputTokens, 0)
    ).toBe(1250)
    const sessionOne = third.sessions.find((session) => session.sessionId === 'session-1')
    expect(sessionOne?.totalInputTokens).toBe(1000)
    expect(sessionOne?.eventCount).toBe(1)
  })

  it('reuses a fully-duplicate backup instead of reparsing it when the live db changes', async () => {
    // The backup only holds stale copies of sessions the canonical db already
    // owns, so it owns nothing. When the live db changes it must not be
    // demoted back into the parse set — there is no claim to reclaim.
    const canonicalPath = writeSessionTotalsDb('opencode.db', [['session-1', 1000]])
    writeSessionTotalsDb('opencode-backup.db', [['session-1', 400]])

    const first = await scanOpenCodeUsageDatabases([], [])
    const firstBackup = first.processedDatabases.find((database) =>
      database.path.endsWith('opencode-backup.db')
    )
    expect(firstBackup?.ownedSessionIds).toEqual([])

    const db = new Database(canonicalPath)
    insertSessionTotalsRow(db, 'session-2', 200)
    db.close()

    const second = await scanOpenCodeUsageDatabases([], first.processedDatabases)
    const secondBackup = second.processedDatabases.find((database) =>
      database.path.endsWith('opencode-backup.db')
    )
    // A reused cache entry is the same object; a reparse would produce a new one.
    expect(secondBackup).toBe(firstBackup)
    expect(
      second.dailyAggregates.reduce((total, aggregate) => total + aggregate.inputTokens, 0)
    ).toBe(1200)
  })

  it('lets the live database reclaim sessions after a sticky backup-only claim', async () => {
    // First scan only has the backup (e.g. live db temporarily missing), so it
    // owns session-1 at the stale snapshot. When opencode.db reappears with
    // higher totals it must reclaim the session instead of staying frozen.
    writeSessionTotalsDb('opencode-backup.db', [['session-1', 400]])

    const first = await scanOpenCodeUsageDatabases([], [])
    expect(
      first.dailyAggregates.reduce((total, aggregate) => total + aggregate.inputTokens, 0)
    ).toBe(400)
    expect(first.processedDatabases[0]?.ownedSessionIds).toEqual(['session-1'])

    writeSessionTotalsDb('opencode.db', [
      ['session-1', 1000],
      ['session-2', 200]
    ])

    const second = await scanOpenCodeUsageDatabases([], first.processedDatabases)
    expect(
      second.dailyAggregates.reduce((total, aggregate) => total + aggregate.inputTokens, 0)
    ).toBe(1200)
    const sessionOne = second.sessions.find((session) => session.sessionId === 'session-1')
    expect(sessionOne?.totalInputTokens).toBe(1000)
    expect(sessionOne?.eventCount).toBe(1)
  })

  it('reclaims sessions when the owning live database is deleted', async () => {
    const canonicalPath = writeSessionTotalsDb('opencode.db', [
      ['session-1', 1000],
      ['session-2', 200]
    ])
    writeSessionTotalsDb('opencode-backup.db', [
      ['session-1', 400],
      ['session-9', 50]
    ])

    const first = await scanOpenCodeUsageDatabases([], [])
    expect(
      first.dailyAggregates.reduce((total, aggregate) => total + aggregate.inputTokens, 0)
    ).toBe(1250)

    unlinkSync(canonicalPath)

    const second = await scanOpenCodeUsageDatabases([], first.processedDatabases)
    expect(
      second.dailyAggregates.reduce((total, aggregate) => total + aggregate.inputTokens, 0)
    ).toBe(450)
    expect(second.sessions.map((session) => session.sessionId).sort()).toEqual([
      'session-1',
      'session-9'
    ])
    const sessionOne = second.sessions.find((session) => session.sessionId === 'session-1')
    expect(sessionOne?.totalInputTokens).toBe(400)
  })
})
