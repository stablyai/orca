import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseOpenCodeUsageDatabase, parseOpenCodeUsageRow } from './scanner'

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
