import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'

const {
  filterPathsToRunningWslDistrosAsync,
  listRunningWslHomeDirsAsync,
  scanAiVaultSessionsInWorker
} = vi.hoisted(() => ({
  filterPathsToRunningWslDistrosAsync: vi.fn(async (paths: readonly string[]) => [...paths]),
  listRunningWslHomeDirsAsync: vi.fn().mockResolvedValue([]),
  scanAiVaultSessionsInWorker: vi.fn()
}))

vi.mock('./session-scanner-worker-spawn', () => ({
  scanAiVaultSessionsInWorker,
  resetAiVaultScannerWorkerForTests: vi.fn()
}))
vi.mock('../wsl', () => ({
  listRunningWslHomeDirsAsync
}))
vi.mock('../wsl-running-path-filter', () => ({ filterPathsToRunningWslDistrosAsync }))

import {
  getAiVaultWslHomeDirs,
  invalidateAiVaultSessionListCache,
  listAiVaultSessions,
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
  scanAiVaultSessionsInWorker.mockReturnValueOnce(
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
    listRunningWslHomeDirsAsync.mockReset().mockResolvedValue([])
    scanAiVaultSessionsInWorker.mockReset()
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
    scanAiVaultSessionsInWorker.mockResolvedValueOnce(scanResult('scan-B'))
    const next = await listAiVaultSessions()

    expect(next.scannedAt).toBe('scan-B')
    expect(scanAiVaultSessionsInWorker).toHaveBeenCalledTimes(2)
  })

  it('caches normally when no invalidation interrupts the scan', async () => {
    scanAiVaultSessionsInWorker.mockResolvedValueOnce(scanResult('scan-A'))
    await listAiVaultSessions()

    // Second non-force call is a cache hit — no second scan.
    const cached = await listAiVaultSessions()

    expect(cached.scannedAt).toBe('scan-A')
    expect(scanAiVaultSessionsInWorker).toHaveBeenCalledTimes(1)
    expect(listRunningWslHomeDirsAsync).toHaveBeenCalledTimes(1)
  })

  it('resolves homes only for distros currently reported as running', async () => {
    listRunningWslHomeDirsAsync.mockResolvedValue(['\\\\wsl.localhost\\Ubuntu\\home\\ada'])

    await expect(getAiVaultWslHomeDirs()).resolves.toEqual(['\\\\wsl.localhost\\Ubuntu\\home\\ada'])
    expect(listRunningWslHomeDirsAsync).toHaveBeenCalledTimes(1)
  })

  it('skips WSL home discovery off Windows', async () => {
    platform = 'linux'

    await expect(getAiVaultWslHomeDirs()).resolves.toEqual([])
    expect(listRunningWslHomeDirsAsync).not.toHaveBeenCalled()
  })
})
