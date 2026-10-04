import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AiVaultListResult } from '../../shared/ai-vault-types'

const {
  filterPathsToRunningWslDistrosAsync,
  getCachedWslDistros,
  hasCachedWslDistros,
  listRunningWslHomeDirsAsync,
  scanAiVaultSessionsInService
} = vi.hoisted(() => ({
  filterPathsToRunningWslDistrosAsync: vi.fn(async (paths: readonly string[]) => [...paths]),
  getCachedWslDistros: vi.fn((): string[] | null => null),
  hasCachedWslDistros: vi.fn(() => false),
  listRunningWslHomeDirsAsync: vi.fn().mockResolvedValue([]),
  scanAiVaultSessionsInService: vi.fn()
}))

vi.mock('./session-scanner-service-spawn', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInService
}))
vi.mock('../wsl', () => ({
  getCachedWslDistros,
  hasCachedWslDistros,
  listRunningWslHomeDirsAsync
}))
vi.mock('../wsl-running-path-filter', () => ({ filterPathsToRunningWslDistrosAsync }))
const reasonixRoots = vi.hoisted(() => vi.fn())
vi.mock('../reasonix/execution-host-config', () => ({
  resolveReasonixExecutionHostRoots: reasonixRoots
}))

import {
  getAiVaultWslHomeDirs,
  invalidateAiVaultSessionListCache,
  listAiVaultSessions,
  localAiVaultScanRoots,
  resetAiVaultSessionListCacheForTests
} from './cached-session-list'

let platform: NodeJS.Platform

function scanResult(scannedAt: string): AiVaultListResult {
  return { sessions: [], issues: [], scannedAt }
}

// A scan whose resolution the test controls, so an invalidation can be injected
// mid-flight.
function deferredScan(): { resolve: (value: AiVaultListResult) => void } {
  let resolveFn: (value: AiVaultListResult) => void = () => {}
  scanAiVaultSessionsInService.mockReturnValueOnce(
    new Promise<AiVaultListResult>((resolve) => {
      resolveFn = resolve
    })
  )
  return { resolve: resolveFn }
}

describe('invalidateAiVaultSessionListCache generation guard', () => {
  beforeEach(() => {
    platform = 'win32'
    vi.spyOn(process, 'platform', 'get').mockImplementation(() => platform)
    resetAiVaultSessionListCacheForTests()
    filterPathsToRunningWslDistrosAsync.mockClear()
    getCachedWslDistros.mockReset().mockReturnValue(null)
    hasCachedWslDistros.mockReset().mockReturnValue(false)
    listRunningWslHomeDirsAsync.mockReset().mockResolvedValue([])
    reasonixRoots.mockReset().mockResolvedValue({
      configHome: join(tmpdir(), 'host-config'),
      stateHome: join(tmpdir(), 'host-state')
    })
    scanAiVaultSessionsInService.mockReset()
  })
  afterEach(() => {
    resetAiVaultSessionListCacheForTests()
    vi.restoreAllMocks()
  })

  it('does not let a scan that started before an invalidation repopulate the cache', async () => {
    // Scan A starts and is still in flight.
    const scanA = deferredScan()
    const inFlight = listAiVaultSessions()

    // A delete invalidates the cache while A is running.
    invalidateAiVaultSessionListCache()

    // A now resolves with a pre-delete result.
    scanA.resolve(scanResult('scan-A'))
    await inFlight

    // A non-force list must re-scan (cache empty) rather than serve A's stale
    // result — proof A's late .then() did not repopulate the cache.
    scanAiVaultSessionsInService.mockResolvedValueOnce(scanResult('scan-B'))
    const next = await listAiVaultSessions()

    expect(next.scannedAt).toBe('scan-B')
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2)
  })

  it('caches normally when no invalidation interrupts the scan', async () => {
    scanAiVaultSessionsInService.mockResolvedValueOnce(scanResult('scan-A'))
    await listAiVaultSessions()

    // Second non-force call is a cache hit — no second scan.
    const cached = await listAiVaultSessions()

    expect(cached.scannedAt).toBe('scan-A')
    expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1)
    expect(listRunningWslHomeDirsAsync).toHaveBeenCalledTimes(1)
  })

  it('skips running-distro discovery once a probe has reported no installed WSL distro', async () => {
    hasCachedWslDistros.mockReturnValue(true)
    getCachedWslDistros.mockReturnValue([])

    await expect(getAiVaultWslHomeDirs()).resolves.toEqual([])
    expect(listRunningWslHomeDirsAsync).not.toHaveBeenCalled()
  })

  it('still discovers running distros before any distro probe has succeeded', async () => {
    hasCachedWslDistros.mockReturnValue(false)
    listRunningWslHomeDirsAsync.mockResolvedValue(['\\\\wsl.localhost\\Ubuntu\\home\\ada'])

    await expect(getAiVaultWslHomeDirs()).resolves.toEqual(['\\\\wsl.localhost\\Ubuntu\\home\\ada'])
    expect(listRunningWslHomeDirsAsync).toHaveBeenCalledTimes(1)
  })

  it('skips WSL home discovery off Windows', async () => {
    platform = 'linux'

    await expect(getAiVaultWslHomeDirs()).resolves.toEqual([])
    expect(listRunningWslHomeDirsAsync).not.toHaveBeenCalled()
  })

  it('shares the owning host storage root with local history and search', async () => {
    const roots = await localAiVaultScanRoots()
    expect(roots.reasonixProjectsDir).toBe(join(tmpdir(), 'host-state', 'projects'))
    expect(roots.executionHostId).toBe('local')
    expect(roots.includeReasonixHistory).toBe(true)
  })

  it('does not probe Reasonix configuration when a legacy client omits history opt-in', async () => {
    const roots = await localAiVaultScanRoots(undefined, false)
    expect(roots.reasonixProjectsDir).toBeUndefined()
    expect(roots.includeReasonixHistory).toBe(false)
    expect(reasonixRoots).not.toHaveBeenCalled()
  })
})
