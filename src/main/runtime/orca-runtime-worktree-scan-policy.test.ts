import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import {
  isMissingRepoPathScanError,
  resolveResolvedWorktreeFleetWaveCount,
  resolveWorktreeScanCacheTtlMs,
  resolveWorktreeScanRetryDelayMs
} from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => tmpdir()) }
}))

// Pinned on purpose: this suite is the policy contract, so each bound gets its own name even where
// two happen to share a value today.
const BASE_TTL_MS = 30_000
const AGENT_SCRATCH_TTL_MS = 5 * 60_000
const MAX_TTL_MS = 5 * 60_000
const MISSING_REPO_RETRY_MS = 5 * 60_000
const FAILURE_RETRY_CAP_MS = 5 * 60_000
const REPO_TIMEOUT_MS = 5_000

describe('resolveWorktreeScanCacheTtlMs', () => {
  it('keeps ordinary, scratch, and SSH policy distinct', () => {
    expect(
      resolveWorktreeScanCacheTtlMs({ path: '/Users/dev/projects/app', connectionId: '' })
    ).toBe(BASE_TTL_MS)
    expect(
      resolveWorktreeScanCacheTtlMs({
        path: '/Users/dev/.codex-tmp/foragent-capsule',
        connectionId: ''
      })
    ).toBe(AGENT_SCRATCH_TTL_MS)
    expect(
      resolveWorktreeScanCacheTtlMs({
        path: '/home/dev/.codex-tmp/capsule',
        connectionId: 'ssh-1'
      })
    ).toBe(BASE_TTL_MS)
  })

  it('spends the global budget on actives first and stretches idle TTLs to the ceiling', () => {
    const idleFleet = { localRepoCount: 107, activeLocalRepoIds: new Set<string>() }
    expect(
      resolveWorktreeScanCacheTtlMs({ id: 'idle', path: '/tmp/idle', connectionId: '' }, idleFleet)
    ).toBe(107_000)

    const mixedFleet = {
      localRepoCount: 107,
      activeLocalRepoIds: new Set(Array.from({ length: 20 }, (_, index) => `active-${index}`))
    }
    expect(
      resolveWorktreeScanCacheTtlMs(
        { id: 'active-0', path: '/tmp/active', connectionId: '' },
        mixedFleet
      )
    ).toBe(BASE_TTL_MS)
    expect(
      resolveWorktreeScanCacheTtlMs({ id: 'idle', path: '/tmp/idle', connectionId: '' }, mixedFleet)
    ).toBe(261_000)

    // 40 actives = 80 scans/min, over the 60/min budget: actives stay eager anyway and the idle
    // repos back all the way off to the ceiling rather than absorbing the overflow.
    const crowdedFleet = {
      localRepoCount: 107,
      activeLocalRepoIds: new Set(Array.from({ length: 40 }, (_, index) => `active-${index}`))
    }
    expect(
      resolveWorktreeScanCacheTtlMs(
        { id: 'active-0', path: '/tmp/active', connectionId: '' },
        crowdedFleet
      )
    ).toBe(BASE_TTL_MS)
    expect(
      resolveWorktreeScanCacheTtlMs(
        { id: 'idle', path: '/tmp/idle', connectionId: '' },
        crowdedFleet
      )
    ).toBe(MAX_TTL_MS)
  })

  it('caps every computed TTL at the five-minute ceiling', () => {
    // 29 actives leave a 2/min idle budget: uncapped the 78 idle repos would wait 39min.
    const nearlySaturatedFleet = {
      localRepoCount: 107,
      activeLocalRepoIds: new Set(Array.from({ length: 29 }, (_, index) => `active-${index}`))
    }
    expect(
      resolveWorktreeScanCacheTtlMs(
        { id: 'active-0', path: '/tmp/active', connectionId: '' },
        nearlySaturatedFleet
      )
    ).toBe(BASE_TTL_MS)
    expect(
      resolveWorktreeScanCacheTtlMs(
        { id: 'idle', path: '/tmp/idle', connectionId: '' },
        nearlySaturatedFleet
      )
    ).toBe(MAX_TTL_MS)

    const hugeCrowdedFleet = {
      localRepoCount: 1000,
      activeLocalRepoIds: new Set(Array.from({ length: 40 }, (_, index) => `active-${index}`))
    }
    expect(
      resolveWorktreeScanCacheTtlMs(
        { id: 'idle', path: '/tmp/idle', connectionId: '' },
        hugeCrowdedFleet
      )
    ).toBe(MAX_TTL_MS)
  })
})

describe('resolveResolvedWorktreeFleetWaveCount', () => {
  it('budgets one per-repo deadline per wave, up to three waves', () => {
    expect(resolveResolvedWorktreeFleetWaveCount(0)).toBe(1)
    expect(resolveResolvedWorktreeFleetWaveCount(8)).toBe(1)
    expect(resolveResolvedWorktreeFleetWaveCount(9)).toBe(2)
    expect(resolveResolvedWorktreeFleetWaveCount(17)).toBe(3)
    // A 107-repo fleet needs 14 waves; the sweep still stops at the ceiling.
    expect(resolveResolvedWorktreeFleetWaveCount(107)).toBe(3)
    // The ceiling any caller can wait — and only a fleet that keeps completing scans reaches it.
    expect(resolveResolvedWorktreeFleetWaveCount(107) * REPO_TIMEOUT_MS).toBe(15_000)
  })
})

describe('resolveWorktreeScanRetryDelayMs', () => {
  it('backs off missing paths immediately and transient failures exponentially', () => {
    expect(resolveWorktreeScanRetryDelayMs('missing_repo_path', 1)).toBe(MISSING_REPO_RETRY_MS)
    expect(resolveWorktreeScanRetryDelayMs('missing_repo_path', 9)).toBe(MISSING_REPO_RETRY_MS)
    expect(resolveWorktreeScanRetryDelayMs('scan_failed', 1)).toBe(30_000)
    expect(resolveWorktreeScanRetryDelayMs('scan_failed', 2)).toBe(60_000)
    expect(resolveWorktreeScanRetryDelayMs('scan_failed', 3)).toBe(120_000)
    expect(resolveWorktreeScanRetryDelayMs('scan_failed', 20)).toBe(FAILURE_RETRY_CAP_MS)
  })
})

describe('isMissingRepoPathScanError', () => {
  it('recognises path error codes without treating unrelated failures as missing', () => {
    expect(isMissingRepoPathScanError(new Error('spawn git ENOENT'))).toBe(true)
    expect(isMissingRepoPathScanError(Object.assign(new Error('boom'), { code: 'ENOTDIR' }))).toBe(
      true
    )
    expect(isMissingRepoPathScanError(new Error('fatal: not a git repository'))).toBe(false)
  })
})
