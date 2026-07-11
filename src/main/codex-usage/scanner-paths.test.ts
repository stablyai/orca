import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'

const { getPathMock, homedirMock } = vi.hoisted(() => ({
  getPathMock: vi.fn<(name: string) => string>(),
  homedirMock: vi.fn<() => string>()
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof NodeOs>('node:os')
  return {
    ...actual,
    homedir: homedirMock
  }
})

import {
  getCodexSessionDirectories,
  getCodexSessionsDirectory,
  listCodexSessionFiles,
  scanCodexUsageFiles
} from './scanner'

const originalCodexHome = process.env.CODEX_HOME
let fakeHomeDir: string
let userDataDir: string
let previousUserDataPath: string | undefined

function usageRecord(
  timestamp: string,
  inputTokens: number,
  totalInputTokens = inputTokens
): string {
  return `${JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5-codex',
        last_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: inputTokens
        },
        total_token_usage: {
          input_tokens: totalInputTokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: totalInputTokens
        }
      }
    }
  })}\n`
}

function totalOnlyUsageRecord(timestamp: string, totalInputTokens: number): string {
  return `${JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        model: 'gpt-5-codex',
        total_token_usage: {
          input_tokens: totalInputTokens,
          cached_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: totalInputTokens
        }
      }
    }
  })}\n`
}

beforeEach(() => {
  delete process.env.CODEX_HOME
  fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-codex-usage-home-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'orca-codex-usage-user-data-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = userDataDir
  homedirMock.mockReturnValue(fakeHomeDir)
  getPathMock.mockImplementation((name: string) => {
    if (name === 'userData') {
      return userDataDir
    }
    throw new Error(`unexpected app.getPath(${name})`)
  })
})

afterEach(() => {
  rmSync(fakeHomeDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
  vi.clearAllMocks()
})

describe('getCodexSessionsDirectory', () => {
  it('defaults to Orca-managed Codex runtime sessions', () => {
    expect(getCodexSessionsDirectory()).toBe(
      join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    )
  })

  it('ignores an ambient CODEX_HOME override', () => {
    process.env.CODEX_HOME = '/tmp/explicit-codex-home'

    expect(getCodexSessionsDirectory()).toBe(
      join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    )
  })
})

describe('listCodexSessionFiles', () => {
  it('scans both Orca-managed and system Codex session homes', async () => {
    const runtimeSessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    const systemSessionsDir = join(fakeHomeDir, '.codex', 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    mkdirSync(systemSessionsDir, { recursive: true })
    const runtimeSessionPath = join(runtimeSessionsDir, 'runtime.jsonl')
    const systemSessionPath = join(systemSessionsDir, 'system.jsonl')
    writeFileSync(runtimeSessionPath, '{}\n', 'utf-8')
    writeFileSync(systemSessionPath, '{}\n', 'utf-8')

    expect(getCodexSessionDirectories()).toEqual([runtimeSessionsDir, systemSessionsDir])
    expect(await listCodexSessionFiles()).toEqual([runtimeSessionPath, systemSessionPath].sort())
  })

  it('dedupes managed session aliases that point at system sessions', async () => {
    const runtimeSessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    const systemSessionsDir = join(fakeHomeDir, '.codex', 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    mkdirSync(systemSessionsDir, { recursive: true })
    const systemSessionPath = join(systemSessionsDir, 'system.jsonl')
    const runtimeSessionPath = join(runtimeSessionsDir, 'system.jsonl')
    writeFileSync(systemSessionPath, '{}\n', 'utf-8')
    linkSync(systemSessionPath, runtimeSessionPath)

    const files = await listCodexSessionFiles()

    expect(files).toHaveLength(1)
    expect(files[0] === runtimeSessionPath || files[0] === systemSessionPath).toBe(true)
  })

  it('does not scan both sides of a diverged legacy copied session bridge', async () => {
    const runtimeSessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    const runtimeBridgeMarkerDir = join(
      userDataDir,
      'codex-runtime-home',
      'home',
      '.orca-session-copies'
    )
    const systemSessionsDir = join(fakeHomeDir, '.codex', 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    mkdirSync(runtimeBridgeMarkerDir, { recursive: true })
    mkdirSync(systemSessionsDir, { recursive: true })
    const systemSessionPath = join(systemSessionsDir, 'system.jsonl')
    const runtimeSessionPath = join(runtimeSessionsDir, 'system.jsonl')
    writeFileSync(systemSessionPath, '{}\n', 'utf-8')
    writeFileSync(runtimeSessionPath, '{}\n', 'utf-8')
    const sourceStat = lstatSync(systemSessionPath)
    const targetStat = lstatSync(runtimeSessionPath)
    writeFileSync(
      join(runtimeBridgeMarkerDir, 'system.jsonl.json'),
      `${JSON.stringify(
        {
          sourcePath: systemSessionPath,
          sourceSize: sourceStat.size,
          sourceMtimeMs: sourceStat.mtimeMs,
          targetSize: targetStat.size,
          targetMtimeMs: targetStat.mtimeMs
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(runtimeSessionPath, '{"runtime":"resumed"}\n', 'utf-8')

    expect(await listCodexSessionFiles()).toEqual([runtimeSessionPath])
  })

  it('keeps both sides of a legacy copied session bridge after both sides diverge', async () => {
    const runtimeSessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    const runtimeBridgeMarkerDir = join(
      userDataDir,
      'codex-runtime-home',
      'home',
      '.orca-session-copies'
    )
    const systemSessionsDir = join(fakeHomeDir, '.codex', 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    mkdirSync(runtimeBridgeMarkerDir, { recursive: true })
    mkdirSync(systemSessionsDir, { recursive: true })
    const systemSessionPath = join(systemSessionsDir, 'system.jsonl')
    const runtimeSessionPath = join(runtimeSessionsDir, 'system.jsonl')
    writeFileSync(systemSessionPath, '{}\n', 'utf-8')
    writeFileSync(runtimeSessionPath, '{}\n', 'utf-8')
    const sourceStat = lstatSync(systemSessionPath)
    const targetStat = lstatSync(runtimeSessionPath)
    writeFileSync(
      join(runtimeBridgeMarkerDir, 'system.jsonl.json'),
      `${JSON.stringify(
        {
          sourcePath: systemSessionPath,
          sourceSize: sourceStat.size,
          sourceMtimeMs: sourceStat.mtimeMs,
          targetSize: targetStat.size,
          targetMtimeMs: targetStat.mtimeMs
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(systemSessionPath, '{"system":"resumed"}\n', 'utf-8')
    writeFileSync(runtimeSessionPath, '{"runtime":"resumed"}\n', 'utf-8')

    expect(await listCodexSessionFiles()).toEqual([runtimeSessionPath, systemSessionPath].sort())
  })

  it('parses only source-side suffix after both sides of a legacy copy diverge', async () => {
    const runtimeSessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    const runtimeBridgeMarkerDir = join(
      userDataDir,
      'codex-runtime-home',
      'home',
      '.orca-session-copies'
    )
    const systemSessionsDir = join(fakeHomeDir, '.codex', 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    mkdirSync(runtimeBridgeMarkerDir, { recursive: true })
    mkdirSync(systemSessionsDir, { recursive: true })
    const systemSessionPath = join(systemSessionsDir, 'system.jsonl')
    const runtimeSessionPath = join(runtimeSessionsDir, 'system.jsonl')
    const copiedPrefix = [
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'legacy-session', cwd: join(fakeHomeDir, 'repo') }
      })}\n`,
      usageRecord('2026-05-26T12:00:00.000Z', 10)
    ].join('')
    writeFileSync(systemSessionPath, copiedPrefix, 'utf-8')
    writeFileSync(runtimeSessionPath, copiedPrefix, 'utf-8')
    const sourceStat = lstatSync(systemSessionPath)
    const targetStat = lstatSync(runtimeSessionPath)
    writeFileSync(
      join(runtimeBridgeMarkerDir, 'system.jsonl.json'),
      `${JSON.stringify(
        {
          sourcePath: systemSessionPath,
          sourceSize: sourceStat.size,
          sourceMtimeMs: sourceStat.mtimeMs,
          targetSize: targetStat.size,
          targetMtimeMs: targetStat.mtimeMs
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(
      systemSessionPath,
      `${copiedPrefix}${usageRecord('2026-05-26T12:01:00.000Z', 3, 13)}`
    )
    writeFileSync(
      runtimeSessionPath,
      `${copiedPrefix}${usageRecord('2026-05-26T12:02:00.000Z', 5, 15)}`
    )

    const result = await scanCodexUsageFiles([], [])

    expect(
      result.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(18)
    expect(
      result.dailyAggregates.reduce((total, aggregate) => total + aggregate.eventCount, 0)
    ).toBe(3)
  })

  it('counts token events copied into forked rollout files exactly once', async () => {
    const sessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const originalPath = join(sessionsDir, 'aaaa-original.jsonl')
    const forkPath = join(sessionsDir, 'bbbb-fork.jsonl')
    const copiedPrefix = [
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-1', cwd: join(fakeHomeDir, 'repo') }
      })}\n`,
      usageRecord('2026-05-26T12:00:00.000Z', 10),
      usageRecord('2026-05-26T12:01:00.000Z', 5, 15)
    ].join('')
    writeFileSync(originalPath, copiedPrefix, 'utf-8')
    writeFileSync(forkPath, `${copiedPrefix}${usageRecord('2026-05-26T12:02:00.000Z', 7, 22)}`)

    const result = await scanCodexUsageFiles([], [])

    expect(
      result.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(22)
    expect(
      result.dailyAggregates.reduce((total, aggregate) => total + aggregate.eventCount, 0)
    ).toBe(3)
    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]?.totalTokens).toBe(22)
  })

  it('dedupes fork copies even when session_meta id is rewritten', async () => {
    const sessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const originalPath = join(sessionsDir, 'aaaa-original.jsonl')
    const forkPath = join(sessionsDir, 'bbbb-fork.jsonl')
    const originalPrefix = [
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-original', cwd: join(fakeHomeDir, 'repo') }
      })}\n`,
      usageRecord('2026-05-26T12:00:00.000Z', 10),
      usageRecord('2026-05-26T12:01:00.000Z', 5, 15)
    ].join('')
    // Same token_count records, different session_meta id (real resume/fork shape).
    const forkBody = [
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-fork', cwd: join(fakeHomeDir, 'repo') }
      })}\n`,
      usageRecord('2026-05-26T12:00:00.000Z', 10),
      usageRecord('2026-05-26T12:01:00.000Z', 5, 15),
      usageRecord('2026-05-26T12:02:00.000Z', 7, 22)
    ].join('')
    writeFileSync(originalPath, originalPrefix, 'utf-8')
    writeFileSync(forkPath, forkBody)

    const result = await scanCodexUsageFiles([], [])
    expect(
      result.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(22)
    expect(result.processedFiles[0]?.ownedEventKeys).toHaveLength(2)
    expect(result.processedFiles[1]?.ownedEventKeys).toHaveLength(1)
    expect(result.processedFiles[1]?.hasDeferredClaims).toBe(true)
  })

  it('does not re-count the cumulative session for copied total-only records', async () => {
    const sessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const originalPath = join(sessionsDir, 'aaaa-original.jsonl')
    const forkPath = join(sessionsDir, 'bbbb-fork.jsonl')
    const copiedPrefix = [
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-1', cwd: join(fakeHomeDir, 'repo') }
      })}\n`,
      totalOnlyUsageRecord('2026-05-26T12:00:00.000Z', 10),
      totalOnlyUsageRecord('2026-05-26T12:01:00.000Z', 15)
    ].join('')
    writeFileSync(originalPath, copiedPrefix, 'utf-8')
    // Without cross-file ownership the fork's first copied total-only record
    // re-counts the entire cumulative session (10) as a fresh delta.
    writeFileSync(
      forkPath,
      `${copiedPrefix}${totalOnlyUsageRecord('2026-05-26T12:02:00.000Z', 22)}`
    )

    const result = await scanCodexUsageFiles([], [])

    expect(
      result.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(22)
    expect(
      result.dailyAggregates.reduce((total, aggregate) => total + aggregate.eventCount, 0)
    ).toBe(3)
  })

  it('keeps fork dedupe stable when the original file is reused from cache', async () => {
    const sessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const originalPath = join(sessionsDir, 'aaaa-original.jsonl')
    const forkPath = join(sessionsDir, 'zzzz-fork.jsonl')
    const copiedPrefix = [
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-1', cwd: join(fakeHomeDir, 'repo') }
      })}\n`,
      usageRecord('2026-05-26T12:00:00.000Z', 10),
      usageRecord('2026-05-26T12:01:00.000Z', 5, 15)
    ].join('')
    writeFileSync(originalPath, copiedPrefix, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(
      first.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(15)
    expect(first.processedFiles[0]?.ownedEventKeys).toHaveLength(2)

    // A fork appears later while the original stays unchanged (cache reuse).
    writeFileSync(forkPath, `${copiedPrefix}${usageRecord('2026-05-26T12:02:00.000Z', 7, 22)}`)

    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(
      second.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(22)
    expect(second.processedFiles.map((file) => file.ownedEventKeys.length)).toEqual([2, 1])

    // Rescanning with the full cache stays stable.
    const third = await scanCodexUsageFiles([], second.processedFiles)
    expect(
      third.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(22)
  })

  it('reclaims copied token events when the owning original file is deleted', async () => {
    const sessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const originalPath = join(sessionsDir, 'aaaa-original.jsonl')
    const forkPath = join(sessionsDir, 'bbbb-fork.jsonl')
    const copiedPrefix = [
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-1', cwd: join(fakeHomeDir, 'repo') }
      })}\n`,
      usageRecord('2026-05-26T12:00:00.000Z', 10),
      usageRecord('2026-05-26T12:01:00.000Z', 5, 15)
    ].join('')
    writeFileSync(originalPath, copiedPrefix, 'utf-8')
    writeFileSync(forkPath, `${copiedPrefix}${usageRecord('2026-05-26T12:02:00.000Z', 7, 22)}`)

    const first = await scanCodexUsageFiles([], [])
    expect(
      first.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(22)
    expect(first.processedFiles[0]?.ownedEventKeys).toHaveLength(2)
    expect(first.processedFiles[0]?.hasDeferredClaims).toBe(false)
    expect(first.processedFiles[1]?.ownedEventKeys).toHaveLength(1)
    expect(first.processedFiles[1]?.hasDeferredClaims).toBe(true)

    // Deleting the owner must reparse deferred forks so they can re-claim the
    // copied prefix instead of permanently under-counting.
    unlinkSync(originalPath)

    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(
      second.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(22)
    expect(second.processedFiles).toHaveLength(1)
    expect(second.processedFiles[0]?.ownedEventKeys).toHaveLength(3)
  })

  it('keeps unrelated cached rollouts when a different owner file is deleted', async () => {
    const sessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
    const originalPath = join(sessionsDir, 'aaaa-original.jsonl')
    const forkPath = join(sessionsDir, 'bbbb-fork.jsonl')
    const unrelatedPath = join(sessionsDir, 'cccc-unrelated.jsonl')
    const copiedPrefix = [
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'session-1', cwd: join(fakeHomeDir, 'repo') }
      })}\n`,
      usageRecord('2026-05-26T12:00:00.000Z', 10),
      usageRecord('2026-05-26T12:01:00.000Z', 5, 15)
    ].join('')
    writeFileSync(originalPath, copiedPrefix, 'utf-8')
    writeFileSync(forkPath, `${copiedPrefix}${usageRecord('2026-05-26T12:02:00.000Z', 7, 22)}`)
    writeFileSync(
      unrelatedPath,
      [
        `${JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-9', cwd: join(fakeHomeDir, 'repo') }
        })}\n`,
        usageRecord('2026-05-26T13:00:00.000Z', 3)
      ].join('')
    )

    const first = await scanCodexUsageFiles([], [])
    const unrelatedBefore = first.processedFiles.find((file) => file.path === unrelatedPath)
    expect(unrelatedBefore?.hasDeferredClaims).toBe(false)
    expect(unrelatedBefore?.ownedEventKeys).toHaveLength(1)

    unlinkSync(originalPath)

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const unrelatedAfter = second.processedFiles.find((file) => file.path === unrelatedPath)
    expect(unrelatedAfter).toBe(unrelatedBefore)
    expect(
      second.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(25)
  })

  it('treats a leading total-only source suffix record as baseline', async () => {
    const runtimeSessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    const runtimeBridgeMarkerDir = join(
      userDataDir,
      'codex-runtime-home',
      'home',
      '.orca-session-copies'
    )
    const systemSessionsDir = join(fakeHomeDir, '.codex', 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    mkdirSync(runtimeBridgeMarkerDir, { recursive: true })
    mkdirSync(systemSessionsDir, { recursive: true })
    const systemSessionPath = join(systemSessionsDir, 'system.jsonl')
    const runtimeSessionPath = join(runtimeSessionsDir, 'system.jsonl')
    const copiedPrefix = [
      `${JSON.stringify({
        type: 'session_meta',
        payload: { id: 'legacy-session', cwd: join(fakeHomeDir, 'repo') }
      })}\n`,
      usageRecord('2026-05-26T12:00:00.000Z', 10)
    ].join('')
    writeFileSync(systemSessionPath, copiedPrefix, 'utf-8')
    writeFileSync(runtimeSessionPath, copiedPrefix, 'utf-8')
    const sourceStat = lstatSync(systemSessionPath)
    const targetStat = lstatSync(runtimeSessionPath)
    writeFileSync(
      join(runtimeBridgeMarkerDir, 'system.jsonl.json'),
      `${JSON.stringify(
        {
          sourcePath: systemSessionPath,
          sourceSize: sourceStat.size,
          sourceMtimeMs: sourceStat.mtimeMs,
          targetSize: targetStat.size,
          targetMtimeMs: targetStat.mtimeMs
        },
        null,
        2
      )}\n`,
      'utf-8'
    )
    writeFileSync(
      systemSessionPath,
      [
        copiedPrefix,
        totalOnlyUsageRecord('2026-05-26T12:01:00.000Z', 13),
        totalOnlyUsageRecord('2026-05-26T12:02:00.000Z', 17)
      ].join('')
    )
    writeFileSync(
      runtimeSessionPath,
      `${copiedPrefix}${usageRecord('2026-05-26T12:03:00.000Z', 5, 15)}`
    )

    const result = await scanCodexUsageFiles([], [])

    expect(
      result.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(19)
    expect(
      result.dailyAggregates.reduce((total, aggregate) => total + aggregate.eventCount, 0)
    ).toBe(3)
  })
})
