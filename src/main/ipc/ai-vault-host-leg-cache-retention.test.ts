import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import { MAX_TIMER_DELAY_MS } from '../../shared/timer-delay'
import {
  AI_VAULT_CACHE_TTL_MS,
  invalidateAiVaultHostLegCache,
  scanHostLegWithCache
} from './ai-vault-host-leg-cache'

const mocks = vi.hoisted(() => ({
  local: vi.fn<() => Promise<AiVaultListResult>>(),
  ssh: vi.fn<(host: string, args?: AiVaultListArgs) => Promise<AiVaultListResult>>()
}))
vi.mock('electron', () => ({ app: { on: vi.fn() }, ipcMain: { handle: vi.fn() } }))
vi.mock('../ai-vault/cached-session-list', () => ({
  configureAiVaultSessionSources: vi.fn(),
  resetAiVaultSessionListCacheForTests: vi.fn(),
  invalidateAiVaultSessionListCache: vi.fn(),
  getAiVaultWslHomeDirs: vi.fn().mockResolvedValue([]),
  listAiVaultSessions: mocks.local
}))
vi.mock('../ai-vault/ssh-session-list', () => ({ scanSshAiVaultSessions: mocks.ssh }))
vi.mock('./ssh', () => ({
  getActiveSshAiVaultHostInfos: () =>
    ['one', 'two', 'three', 'four'].map((targetId) => ({ targetId }))
}))
const { _internals } = await import('./ai-vault')

function result(marker: string): AiVaultListResult {
  return {
    sessions: Array.from({ length: 4 }, (_, index) => ({
      id: `local:codex:${marker}-${index}`,
      executionHostId: 'local',
      agent: 'codex',
      sessionId: `${marker}-${index}`,
      title: marker,
      cwd: index === 0 ? '/other' : '/workspaces/project',
      branch: null,
      model: null,
      filePath: `/tmp/${marker}-${index}.jsonl`,
      codexHome: null,
      createdAt: null,
      updatedAt: null,
      modifiedAt: '2026-10-02T00:00:00Z',
      messageCount: 1,
      totalTokens: 0,
      previewMessages: [],
      queuedMessageCount: 0,
      subagentTranscriptCount: 0,
      resumeCommand: `codex resume ${marker}-${index}`,
      subagent: null
    })),
    issues: [],
    scannedAt: '2026-10-02T00:00:00Z'
  }
}

function args(scan: () => Promise<AiVaultListResult>, force = false, depth = 4) {
  return { cacheKey: 'leg', depth, force, scopePaths: ['/workspaces/project'], scan }
}

async function cacheOwner(
  run: () => Promise<unknown>,
  suffix = 'leg'
): Promise<Map<unknown, unknown>> {
  const writes = vi.spyOn(Map.prototype, 'set')
  try {
    await run()
    const calls: readonly (readonly unknown[])[] = writes.mock.calls
    const index = calls.findIndex(
      ([key, value]) =>
        typeof key === 'string' &&
        key.endsWith(suffix) &&
        typeof value === 'object' &&
        value !== null &&
        'expiresAt' in value &&
        'result' in value
    )
    const owner: unknown = writes.mock.contexts[index]
    if (!(owner instanceof Map)) {
      throw new Error('Host cache did not store the scanned result')
    }
    return owner
  } finally {
    writes.mockRestore()
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  mocks.local.mockResolvedValue({ sessions: [], issues: [], scannedAt: '2026-10-02T00:00:00Z' })
  mocks.ssh.mockImplementation(async (host, input) => result(`${host}-${input?.scopePaths?.[0]}`))
})
afterEach(() => {
  _internals.resetAiVaultCacheForTests()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('host session result cache lifetime', () => {
  it('keeps the refreshed deadline and cached scoped depth when the old timer fires', async () => {
    const scan = vi.fn().mockResolvedValue(result('old'))
    const owner = await cacheOwner(() => scanHostLegWithCache(args(scan)))
    await vi.advanceTimersByTimeAsync(4000)
    scan.mockResolvedValue(result('fresh'))
    await scanHostLegWithCache(args(scan, true))
    await vi.advanceTimersByTimeAsync(11000)
    const narrow = await scanHostLegWithCache(args(scan, false, 2))
    expect(narrow.sessions.map((session) => session.id)).toEqual(
      [0, 1, 2].map((index) => `local:codex:fresh-${index}`)
    )
    expect(scan).toHaveBeenCalledTimes(2)
    expect(owner.size).toBe(1)
    await vi.advanceTimersByTimeAsync(3999)
    expect(owner.size).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(owner.size).toBe(0)
  })

  it('invalidates the timer and fences a scan that completes after deletion', async () => {
    const scan = vi.fn().mockResolvedValue(result('existing'))
    await scanHostLegWithCache(args(scan))
    let finish: (value: AiVaultListResult) => void = () => {
      throw new Error('Scan not started')
    }
    const pending = scanHostLegWithCache(
      args(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
        true
      )
    )
    invalidateAiVaultHostLegCache()
    expect(vi.getTimerCount()).toBe(0)
    finish(result('stale'))
    await expect(pending).resolves.toEqual(result('stale'))
    expect(vi.getTimerCount()).toBe(0)
    scan.mockResolvedValue(result('after-delete'))
    await expect(scanHostLegWithCache(args(scan))).resolves.toEqual(result('after-delete'))
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('preserves a healthy cached result through host errors, throws and cancellation', async () => {
    const scan = vi.fn().mockResolvedValue(result('healthy'))
    await scanHostLegWithCache(args(scan))
    const hostError: AiVaultListResult = {
      sessions: [],
      issues: [{ agent: 'codex', kind: 'host', path: 'remote', message: 'offline' }],
      scannedAt: 'error'
    }
    await expect(scanHostLegWithCache(args(async () => hostError, true))).resolves.toBe(hostError)
    for (const error of [
      new Error('failure'),
      Object.assign(new Error('cancelled'), { name: 'AbortError' })
    ]) {
      await expect(
        scanHostLegWithCache(
          args(async () => {
            throw error
          }, true)
        )
      ).rejects.toBe(error)
    }
    expect((await scanHostLegWithCache(args(scan))).sessions[0].title).toBe('healthy')
    expect(scan).toHaveBeenCalledTimes(1)
  })

  it('keeps the first completed covering depth while returning every concurrent result', async () => {
    let finish: (value: AiVaultListResult) => void = () => {
      throw new Error('Scan not started')
    }
    const later = scanHostLegWithCache(
      args(
        () =>
          new Promise((resolve) => {
            finish = resolve
          }),
        false,
        2
      )
    )
    await scanHostLegWithCache(args(async () => result('first')))
    finish(result('later'))
    await expect(later).resolves.toEqual(result('later'))
    const unused = vi.fn().mockResolvedValue(result('unused'))
    expect((await scanHostLegWithCache(args(unused, false, 2))).sessions[0].title).toBe('first')
    expect(unused).not.toHaveBeenCalled()
    await scanHostLegWithCache(args(unused, false, 5))
    expect(unused).toHaveBeenCalledTimes(1)
  })

  it('rechecks wall time after rollback and expires at the original deadline', async () => {
    const owner = await cacheOwner(() => scanHostLegWithCache(args(async () => result('clock'))))
    vi.setSystemTime(-10_000)
    await vi.advanceTimersByTimeAsync(AI_VAULT_CACHE_TTL_MS)
    expect(owner.size).toBe(1)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_999)
    expect(owner.size).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(owner.size).toBe(0)
  })

  it('caps re-armed delays after a large backward clock change', async () => {
    await scanHostLegWithCache(args(async () => result('clock')))
    const timeouts = vi.spyOn(globalThis, 'setTimeout')
    vi.setSystemTime(-3_000_000_000)
    await vi.advanceTimersByTimeAsync(AI_VAULT_CACHE_TTL_MS)
    const calls: readonly (readonly unknown[])[] = timeouts.mock.calls
    expect(calls).toHaveLength(1)
    expect(calls[0][1]).toBe(MAX_TIMER_DELAY_MS)
    expect(vi.getTimerCount()).toBe(1)
  })
})
