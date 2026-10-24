import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
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
  listCodexSessionFiles
} from './codex-session-file-discovery'
import { scanCodexUsageFiles } from './scanner'

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

  it('scans per-account self-contained Codex homes that hold sessions', async () => {
    const runtimeSessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    const systemSessionsDir = join(fakeHomeDir, '.codex', 'sessions')
    const accountSessionsDir = join(userDataDir, 'codex-accounts', 'acct-1', 'home', 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    mkdirSync(systemSessionsDir, { recursive: true })
    mkdirSync(accountSessionsDir, { recursive: true })
    writeFileSync(
      join(userDataDir, 'codex-accounts', 'acct-1', 'home', '.orca-managed-home'),
      'acct-1\n',
      'utf-8'
    )
    // Auth-only account homes must not add scan roots.
    mkdirSync(join(userDataDir, 'codex-accounts', 'acct-2', 'home'), { recursive: true })
    const accountSessionPath = join(accountSessionsDir, 'account.jsonl')
    writeFileSync(
      accountSessionPath,
      [
        `${JSON.stringify({
          type: 'session_meta',
          payload: { id: 'account-session', cwd: join(fakeHomeDir, 'repo') }
        })}\n`,
        usageRecord('2026-07-21T12:00:00.000Z', 42)
      ].join(''),
      'utf-8'
    )

    expect(getCodexSessionDirectories()).toEqual([
      runtimeSessionsDir,
      systemSessionsDir,
      accountSessionsDir
    ])
    expect(await listCodexSessionFiles()).toEqual([accountSessionPath])
    const result = await scanCodexUsageFiles([], [])
    expect(result.sessions).toHaveLength(1)
    expect(result.dailyAggregates).toEqual([
      expect.objectContaining({ totalTokens: 42, eventCount: 1 })
    ])
  })

  it('does not scan an account home redirected outside managed storage', async () => {
    const accountDir = join(userDataDir, 'codex-accounts', 'acct-redirected')
    const externalHome = join(fakeHomeDir, 'redirected-account-home')
    const externalSessionsDir = join(externalHome, 'sessions')
    mkdirSync(accountDir, { recursive: true })
    mkdirSync(externalSessionsDir, { recursive: true })
    writeFileSync(join(externalHome, '.orca-managed-home'), 'acct-redirected\n', 'utf-8')
    writeFileSync(join(externalSessionsDir, 'unrelated.jsonl'), '{}\n', 'utf-8')
    symlinkSync(
      externalHome,
      join(accountDir, 'home'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    expect(getCodexSessionDirectories()).not.toContain(join(accountDir, 'home', 'sessions'))
    expect(await listCodexSessionFiles()).toEqual([])
  })

  it('does not scan a sessions root redirected outside an owned account home', async () => {
    const accountHome = join(userDataDir, 'codex-accounts', 'acct-redirected-sessions', 'home')
    const externalSessionsDir = join(fakeHomeDir, 'redirected-sessions')
    mkdirSync(accountHome, { recursive: true })
    mkdirSync(externalSessionsDir, { recursive: true })
    writeFileSync(join(accountHome, '.orca-managed-home'), 'acct-redirected-sessions\n', 'utf-8')
    writeFileSync(join(externalSessionsDir, 'unrelated.jsonl'), '{}\n', 'utf-8')
    symlinkSync(
      externalSessionsDir,
      join(accountHome, 'sessions'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )

    expect(getCodexSessionDirectories()).not.toContain(join(accountHome, 'sessions'))
    expect(await listCodexSessionFiles()).toEqual([])
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

    // Removing bridge markers must restore full-history parsing, including the skipped prefix.
    rmSync(runtimeBridgeMarkerDir, { recursive: true, force: true })
    rmSync(runtimeSessionPath)
    writeFileSync(
      systemSessionPath,
      `${copiedPrefix}${usageRecord('2026-05-26T12:01:00.000Z', 3, 13)}${usageRecord('2026-05-26T12:03:00.000Z', 4, 17)}`
    )

    const afterBridge = await scanCodexUsageFiles([], result.processedFiles)

    expect(
      afterBridge.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(17)
    expect(
      afterBridge.dailyAggregates.reduce((total, aggregate) => total + aggregate.eventCount, 0)
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
    // Forks retain usage records while rewriting session metadata.
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
    // A copied total-only record must not recount its entire cumulative prefix.
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

    writeFileSync(forkPath, `${copiedPrefix}${usageRecord('2026-05-26T12:02:00.000Z', 7, 22)}`)

    const second = await scanCodexUsageFiles([], first.processedFiles)
    expect(
      second.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(22)
    expect(second.processedFiles.map((file) => file.ownedEventKeys.length)).toEqual([2, 1])

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

  // New bridge markers must discard full-history checkpoints to avoid recounting the copied prefix.
  it('reparses in full when bridge markers appear on an already-resumable source', async () => {
    const runtimeSessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    const runtimeBridgeMarkerDir = join(
      userDataDir,
      'codex-runtime-home',
      'home',
      '.orca-session-copies'
    )
    const systemSessionsDir = join(fakeHomeDir, '.codex', 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    mkdirSync(systemSessionsDir, { recursive: true })
    const systemSessionPath = join(systemSessionsDir, 'system.jsonl')
    const runtimeSessionPath = join(runtimeSessionsDir, 'system.jsonl')
    const meta = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: 'legacy-session', cwd: join(fakeHomeDir, 'repo') }
    })}\n`
    // Clear the resume floor so the cache-to-bridge transition is exercised.
    let padding = ''
    for (let index = 0; index < 40; index++) {
      const minute = String(index).padStart(2, '0')
      padding += usageRecord(`2026-05-26T11:${minute}:00.000Z`, 1, index + 1)
    }
    const scannedPrefix = `${meta}${padding}${usageRecord('2026-05-26T12:00:00.000Z', 10, 50)}`
    writeFileSync(systemSessionPath, scannedPrefix, 'utf-8')

    const first = await scanCodexUsageFiles([], [])
    expect(
      first.processedFiles.find((file) => file.path === systemSessionPath)?.parseResumeState
        ?.parsedBytes
    ).toBe(Buffer.byteLength(scannedPrefix))

    // Copy beyond the cached checkpoint to exercise suffix-only baseline handling.
    const copiedPrefix = `${scannedPrefix}${usageRecord('2026-05-26T12:01:00.000Z', 3, 53)}`
    writeFileSync(systemSessionPath, copiedPrefix, 'utf-8')
    writeFileSync(runtimeSessionPath, copiedPrefix, 'utf-8')
    mkdirSync(runtimeBridgeMarkerDir, { recursive: true })
    const sourceStat = lstatSync(systemSessionPath)
    const targetStat = lstatSync(runtimeSessionPath)
    writeFileSync(
      join(runtimeBridgeMarkerDir, 'system.jsonl.json'),
      `${JSON.stringify({
        sourcePath: systemSessionPath,
        sourceSize: sourceStat.size,
        sourceMtimeMs: sourceStat.mtimeMs,
        targetSize: targetStat.size,
        targetMtimeMs: targetStat.mtimeMs
      })}\n`,
      'utf-8'
    )
    writeFileSync(
      systemSessionPath,
      [
        copiedPrefix,
        totalOnlyUsageRecord('2026-05-26T12:02:00.000Z', 70),
        totalOnlyUsageRecord('2026-05-26T12:03:00.000Z', 74)
      ].join('')
    )
    writeFileSync(
      runtimeSessionPath,
      `${copiedPrefix}${usageRecord('2026-05-26T12:04:00.000Z', 5, 58)}`
    )

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const cold = await scanCodexUsageFiles([], [])

    // Count copied prefix (53), runtime suffix (5), and source suffix delta (74 - 70).
    expect(
      second.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(62)
    expect(
      second.dailyAggregates.reduce((total, aggregate) => total + aggregate.eventCount, 0)
    ).toBe(44)
    expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
  })

  // Bridge markers invalidate full-history cache reuse even when file metadata is unchanged.
  it('does not reuse a pre-bridge cache once the source became suffix-only', async () => {
    const runtimeSessionsDir = join(userDataDir, 'codex-runtime-home', 'home', 'sessions')
    const markerDir = join(userDataDir, 'codex-runtime-home', 'home', '.orca-session-copies')
    const systemSessionsDir = join(fakeHomeDir, '.codex', 'sessions')
    mkdirSync(runtimeSessionsDir, { recursive: true })
    mkdirSync(systemSessionsDir, { recursive: true })
    const systemSessionPath = join(systemSessionsDir, 'system.jsonl')
    const runtimeSessionPath = join(runtimeSessionsDir, 'system.jsonl')
    const meta = `${JSON.stringify({
      type: 'session_meta',
      payload: { id: 'legacy-session', cwd: join(fakeHomeDir, 'repo') }
    })}\n`
    const copiedPrefix = `${meta}${usageRecord('2026-05-26T12:00:00.000Z', 10)}`
    // A total-only suffix establishes a baseline; a full-history parse would count a delta.
    writeFileSync(
      systemSessionPath,
      `${copiedPrefix}${totalOnlyUsageRecord('2026-05-26T12:01:00.000Z', 13)}`,
      'utf-8'
    )

    const first = await scanCodexUsageFiles([], [])
    const cachedStat = lstatSync(systemSessionPath)

    // Add markers without changing the source file metadata.
    mkdirSync(markerDir, { recursive: true })
    writeFileSync(
      runtimeSessionPath,
      `${copiedPrefix}${usageRecord('2026-05-26T12:02:00.000Z', 5, 15)}`,
      'utf-8'
    )
    writeFileSync(
      join(markerDir, 'system.jsonl.json'),
      `${JSON.stringify({
        sourcePath: systemSessionPath,
        sourceSize: Buffer.byteLength(copiedPrefix),
        sourceMtimeMs: cachedStat.mtimeMs - 5000,
        targetSize: Buffer.byteLength(copiedPrefix),
        targetMtimeMs: cachedStat.mtimeMs - 5000
      })}\n`,
      'utf-8'
    )
    expect(lstatSync(systemSessionPath).size).toBe(cachedStat.size)
    expect(lstatSync(systemSessionPath).mtimeMs).toBe(cachedStat.mtimeMs)

    const second = await scanCodexUsageFiles([], first.processedFiles)
    const cold = await scanCodexUsageFiles([], [])
    expect(
      second.dailyAggregates.reduce((total, aggregate) => total + aggregate.totalTokens, 0)
    ).toBe(15)
    expect(second.dailyAggregates).toEqual(cold.dailyAggregates)
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
