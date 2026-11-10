import { mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from '../sqlite/sync-database'
import { listOpenCodeDatabases } from './opencode-database-discovery'
import { parseOpenCodeUsageRow } from './opencode-usage-row-parsing'
import { scanOpenCodeUsageDatabases } from './scanner'

const WORKTREE = '/workspace/repo'

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
      tokens_cache_write INTEGER,
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
      tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
      time_created, time_updated
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    0,
    1_777_777_700_000,
    1_777_777_800_000
  )
}

describe('parseOpenCodeUsageRow', () => {
  it.each([
    [undefined, 10_125],
    [125, 10_125],
    [10_125, 10_125],
    [20_000, 20_000]
  ])('counts cache reads once with reported total %s', (total, expectedTotal) => {
    const parsed = parseOpenCodeUsageRow({
      id: 'message-cache-heavy',
      session_id: 'session-cache-heavy',
      time_created: 1_777_777_700_000,
      time_updated: null,
      directory: WORKTREE,
      title: null,
      worktree: null,
      session_model: null,
      data: JSON.stringify({
        modelID: 'deepseek-v4.1-flash',
        providerID: 'opencode-go',
        tokens: {
          input: 100,
          output: 20,
          reasoning: 5,
          total,
          cache: { read: 10_000, write: 0 }
        },
        time: { completed: 1_777_777_800_000 }
      })
    })

    expect(parsed).toMatchObject({
      inputTokens: 10_100,
      cachedInputTokens: 10_000,
      outputTokens: 20,
      reasoningOutputTokens: 5,
      totalTokens: expectedTotal
    })
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

  function appendLiveSessionRow(path: string, sessionId: string, inputTokens: number): void {
    const previousMtimeMs = statSync(path).mtimeMs
    const db = new Database(path)
    insertSessionTotalsRow(db, sessionId, inputTokens)
    db.close()
    // A same-page write may retain coarse mtime; force the scanner’s mtime/size fingerprint to change.
    const changedAt = new Date(previousMtimeMs + 1000)
    utimesSync(path, changedAt, changedAt)
  }

  it('does not scan disk databases when OPENCODE_DB uses memory', async () => {
    writeSessionTotalsDb('opencode.db', [])
    process.env.OPENCODE_DB = ':memory:'

    await expect(listOpenCodeDatabases()).resolves.toEqual([])
  })

  it('does not return a directory configured as OPENCODE_DB', async () => {
    process.env.OPENCODE_DB = '.'

    await expect(listOpenCodeDatabases()).resolves.toEqual([])
  })

  it('counts a session duplicated into a stale backup database exactly once', async () => {
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

    appendLiveSessionRow(canonicalPath, 'session-2', 200)

    const third = await scanOpenCodeUsageDatabases([], second.processedDatabases)
    expect(
      third.dailyAggregates.reduce((total, aggregate) => total + aggregate.inputTokens, 0)
    ).toBe(1250)
    const sessionOne = third.sessions.find((session) => session.sessionId === 'session-1')
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
