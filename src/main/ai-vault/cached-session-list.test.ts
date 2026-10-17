import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import { aiVaultLocalScanKey } from '../../shared/ai-vault-local-scan-key'
import {
  localAiVaultScanProgress,
  resetLocalAiVaultScanProgressForTests,
  type LocalAiVaultScanProgressHandle
} from './ai-vault-local-scan-progress'

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
  const pending = new Promise<AiVaultListResult>((resolve) => {
    resolveFn = resolve
  })
  scanAiVaultSessionsInService.mockImplementationOnce(
    async (_options, _signal, progress?: LocalAiVaultScanProgressHandle) => {
      progress?.sent()
      const value = await pending
      progress?.finish(null)
      return value
    }
  )
  return { resolve: resolveFn }
}

describe('invalidateAiVaultSessionListCache generation guard', () => {
  beforeEach(() => {
    platform = 'win32'
    vi.spyOn(process, 'platform', 'get').mockImplementation(() => platform)
    resetAiVaultSessionListCacheForTests()
    resetLocalAiVaultScanProgressForTests()
    filterPathsToRunningWslDistrosAsync.mockClear()
    getCachedWslDistros.mockReset().mockReturnValue(null)
    hasCachedWslDistros.mockReset().mockReturnValue(false)
    listRunningWslHomeDirsAsync.mockReset().mockResolvedValue([])
    scanAiVaultSessionsInService.mockReset()
  })
  afterEach(() => {
    resetAiVaultSessionListCacheForTests()
    resetLocalAiVaultScanProgressForTests()
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

  it.each(['old-first', 'new-first'])(
    'keeps post-invalidation scans separate with %s completion',
    async (order) => {
      const request = { scopePaths: ['/project'] }
      const scanKey = aiVaultLocalScanKey(request)
      const scanA = deferredScan()
      const beforeDelete = listAiVaultSessions(request)
      await vi.waitFor(() => expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(1))

      invalidateAiVaultSessionListCache()
      const scanB = deferredScan()
      const afterDelete = listAiVaultSessions(request)
      const sameGeneration = listAiVaultSessions(request)
      try {
        await vi.waitFor(() => expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2))
        if (order === 'old-first') {
          scanA.resolve(scanResult('scan-A'))
          await beforeDelete
        }
        scanB.resolve(scanResult('scan-B'))
        const fresh = await afterDelete
        expect(fresh.scannedAt).toBe('scan-B')
        expect(fresh.scanId).toEqual(expect.any(String))
        expect((await sameGeneration).scanId).toBe(fresh.scanId)

        scanA.resolve(scanResult('scan-A'))
        const old = await beforeDelete
        expect(old.scannedAt).toBe('scan-A')
        expect(old.scanId).not.toBe(fresh.scanId)
        const cached = await listAiVaultSessions(request)
        expect(cached.scannedAt).toBe('scan-B')
        expect(cached.scanId).toBe(fresh.scanId)
        expect(localAiVaultScanProgress(scanKey)).toMatchObject({
          scanId: fresh.scanId,
          stage: 'finished'
        })
        expect(scanAiVaultSessionsInService).toHaveBeenCalledTimes(2)
      } finally {
        scanA.resolve(scanResult('scan-A'))
        scanB.resolve(scanResult('scan-B'))
        await Promise.allSettled([beforeDelete, afterDelete, sameGeneration])
      }
    }
  )

  it('caches normally when no invalidation interrupts the scan', async () => {
    scanAiVaultSessionsInService.mockResolvedValueOnce(scanResult('scan-A'))
    const request = { limit: 1000, scopePaths: ['/project'] }
    const first = await listAiVaultSessions(request)

    // A narrower request reuses the same scan entry and its scan ID.
    const cached = await listAiVaultSessions({ ...request, limit: 100 })

    expect(cached.scannedAt).toBe('scan-A')
    expect(cached.scanId).toBe(first.scanId)
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
})
