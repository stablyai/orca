import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'

const { scanAiVaultSessionsInWorker } = vi.hoisted(() => ({
  scanAiVaultSessionsInWorker: vi.fn()
}))

vi.mock('./session-scanner-worker-spawn', () => ({
  scanAiVaultSessionsInWorker,
  resetAiVaultScannerWorkerForTests: vi.fn()
}))
vi.mock('../wsl', () => ({
  getWslHomeAsync: vi.fn(),
  listWslDistrosAsync: vi.fn().mockResolvedValue([])
}))

import {
  invalidateAiVaultSessionListCache,
  listAiVaultSessions,
  resetAiVaultSessionListCacheForTests
} from './cached-session-list'

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
    resetAiVaultSessionListCacheForTests()
    scanAiVaultSessionsInWorker.mockReset()
  })
  afterEach(() => {
    resetAiVaultSessionListCacheForTests()
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
  })
})
