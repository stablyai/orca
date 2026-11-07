import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as transcriptFs from '../native-chat/wsl-transcript-fs-access'
import { getLocalUsageDay } from '../usage/usage-calendar-range'
import type { UsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import { parseZcodeUsageDatabase, scanZcodeUsageDatabases } from './scanner'
import {
  buildZcodeUsageDailyPoints,
  buildZcodeUsageRecentSessions,
  buildZcodeUsageSummary
} from './snapshot-rollups'
import { writeZcodeUsageDatabase, ZCODE_USAGE_FIXTURE_EPOCH_MS } from './zcode-usage-sqlite-fixture'

const DAY = getLocalUsageDay(new Date(ZCODE_USAGE_FIXTURE_EPOCH_MS).toISOString())

const resolveRepoWorktree: UsageWorktreeResolver = (cwd) =>
  cwd === '/repo'
    ? {
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        path: '/repo',
        displayName: 'repo'
      }
    : null

describe('zcode usage scanner', () => {
  let dbRoot: string
  let dbPath: string
  let previousZcodeDb: string | undefined

  beforeAll(() => {
    dbRoot = mkdtempSync(join(tmpdir(), 'orca-zcode-usage-'))
    dbPath = join(dbRoot, 'db.sqlite')
    writeZcodeUsageDatabase(dbPath, {
      sessions: [
        { id: 'session_main', directory: '/repo' },
        { id: 'session_sub', directory: '/repo', taskType: 'subagent_child' }
      ],
      usage: [
        {
          id: 'u1',
          sessionId: 'session_main',
          inputTokens: 900,
          outputTokens: 100,
          reasoningTokens: 40,
          cacheReadInputTokens: 800,
          cacheCreationInputTokens: 20
        },
        {
          id: 'u2',
          sessionId: 'session_sub',
          modelId: null,
          providerId: 'account:plan',
          taskType: 'subagent_child',
          startedAt: ZCODE_USAGE_FIXTURE_EPOCH_MS + 60_000,
          completedAt: ZCODE_USAGE_FIXTURE_EPOCH_MS + 90_000,
          inputTokens: 500,
          outputTokens: 10,
          cacheReadInputTokens: 480
        },
        {
          // Zero-token rows (cancelled before any completion) never count.
          id: 'u3',
          sessionId: 'session_main',
          status: 'cancelled'
        },
        {
          // An orphaned row whose session row is gone still counts as unscoped usage.
          id: 'u4',
          sessionId: 'session_gone',
          startedAt: ZCODE_USAGE_FIXTURE_EPOCH_MS + 120_000,
          completedAt: ZCODE_USAGE_FIXTURE_EPOCH_MS + 130_000,
          inputTokens: 70,
          outputTokens: 30
        }
      ]
    })
    previousZcodeDb = process.env.ZCODE_DB
    process.env.ZCODE_DB = dbPath
  })

  afterEach(() => vi.restoreAllMocks())

  afterAll(() => {
    if (previousZcodeDb === undefined) {
      delete process.env.ZCODE_DB
    } else {
      process.env.ZCODE_DB = previousZcodeDb
    }
    rmSync(dbRoot, { recursive: true, force: true })
  })

  it('parses model_usage rows into sessions and daily aggregates', async () => {
    const processed = await parseZcodeUsageDatabase(dbPath, resolveRepoWorktree)

    expect(processed.sessions).toHaveLength(3)
    const main = processed.sessions.find((session) => session.sessionId === 'session_main')
    expect(main).toMatchObject({
      eventCount: 1,
      totalInputTokens: 900,
      // Cache reads and cache writes are subsets of the recorded input total.
      totalCachedInputTokens: 820,
      cacheReadInputTokens: 800,
      cacheWriteInputTokens: 20,
      totalOutputTokens: 100,
      totalReasoningOutputTokens: 40,
      totalTokens: 1_000,
      primaryModel: 'GLM-5.3',
      primaryProjectLabel: 'repo',
      primaryWorktreeId: 'wt-1'
    })
    const sub = processed.sessions.find((session) => session.sessionId === 'session_sub')
    // A NULL model_id falls back to the provider id.
    expect(sub).toMatchObject({ primaryModel: 'account:plan', primaryWorktreeId: 'wt-1' })
    const orphan = processed.sessions.find((session) => session.sessionId === 'session_gone')
    expect(orphan).toMatchObject({ totalTokens: 100, primaryProjectLabel: 'Unknown location' })

    expect(processed.dailyAggregates).toHaveLength(3)
    expect(processed.dailyAggregates.every((row) => row.day === DAY)).toBe(true)

    const summary = buildZcodeUsageSummary(
      'all',
      'all',
      processed.dailyAggregates,
      processed.sessions
    )
    expect(summary).toMatchObject({
      cachedInputTokens: 1_300,
      cacheReadInputTokens: 1_280,
      cacheWriteInputTokens: 20
    })
    expect(buildZcodeUsageDailyPoints(processed.dailyAggregates)).toEqual([
      expect.objectContaining({
        day: DAY,
        cachedInputTokens: 1_300,
        cacheReadInputTokens: 1_280,
        cacheWriteInputTokens: 20
      })
    ])
    expect(buildZcodeUsageRecentSessions(processed.sessions)).toContainEqual(
      expect.objectContaining({
        sessionId: 'session_main',
        cachedInputTokens: 820,
        cacheReadInputTokens: 800,
        cacheWriteInputTokens: 20
      })
    )
  })

  it('reuses a scanned database until its stat changes, then reparses it', async () => {
    const first = await scanZcodeUsageDatabases([], [], undefined)
    expect(first.processedDatabases).toHaveLength(1)

    const [cached] = first.processedDatabases
    const marker = {
      ...cached,
      sessions: [{ ...first.sessions[0], sessionId: 'session_marker' }]
    }
    const reused = await scanZcodeUsageDatabases([], [marker], undefined)
    expect(reused.sessions.map((session) => session.sessionId)).toEqual(['session_marker'])

    utimesSync(
      dbPath,
      new Date(ZCODE_USAGE_FIXTURE_EPOCH_MS),
      new Date(ZCODE_USAGE_FIXTURE_EPOCH_MS + 5_000)
    )
    const reparsed = await scanZcodeUsageDatabases([], [marker], undefined)
    expect(reparsed.sessions).toEqual(first.sessions)

    rmSync(dbPath)
    writeZcodeUsageDatabase(dbPath, {
      usage: [{ id: 'x1', sessionId: 's_new', inputTokens: 5, outputTokens: 5 }]
    })
    const grown = await scanZcodeUsageDatabases([], first.processedDatabases, undefined)
    expect(grown.sessions).toHaveLength(1)
    expect(grown.sessions[0]).toMatchObject({ sessionId: 's_new', totalTokens: 10 })
  })

  it('rejects a non-ENOENT metadata failure instead of reporting stale data as current', async () => {
    const first = await scanZcodeUsageDatabases([], [], undefined)
    const stat = transcriptFs.wslGatedStat
    let calls = 0
    vi.spyOn(transcriptFs, 'wslGatedStat').mockImplementation((path, ...args) => {
      calls += 1
      if (calls === 2) {
        const error = new Error('Generated metadata failure')
        Object.assign(error, { code: 'EACCES' })
        throw error
      }
      return stat(path, ...args)
    })

    await expect(scanZcodeUsageDatabases([], first.processedDatabases, undefined)).rejects.toThrow(
      'Generated metadata failure'
    )
  })

  it('rejects a first-scan parse failure instead of reporting empty usage', async () => {
    writeFileSync(dbPath, 'not a sqlite database')

    await expect(scanZcodeUsageDatabases([], [], undefined)).rejects.toThrow()

    rmSync(dbPath)
    writeZcodeUsageDatabase(dbPath, {
      sessions: [{ id: 'session_main', directory: '/repo' }],
      usage: [{ id: 'restore', sessionId: 'session_main', inputTokens: 1, outputTokens: 1 }]
    })
  })

  it('keeps the last good snapshot when a changed database is temporarily unreadable', async () => {
    const first = await scanZcodeUsageDatabases([], [], undefined)
    writeFileSync(dbPath, 'not a sqlite database')
    utimesSync(
      dbPath,
      new Date(ZCODE_USAGE_FIXTURE_EPOCH_MS),
      new Date(ZCODE_USAGE_FIXTURE_EPOCH_MS + 10_000)
    )

    const stale = await scanZcodeUsageDatabases([], first.processedDatabases, undefined)

    expect(stale.processedDatabases).toEqual(first.processedDatabases)
    expect(stale.sessions).toEqual(first.sessions)
    rmSync(dbPath)
    writeZcodeUsageDatabase(dbPath, {
      sessions: [{ id: 'session_main', directory: '/repo' }],
      usage: [{ id: 'restore', sessionId: 'session_main', inputTokens: 1, outputTokens: 1 }]
    })
  })
})
