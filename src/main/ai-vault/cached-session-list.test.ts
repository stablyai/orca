import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultListResult } from '../../shared/ai-vault-types'
import type { AiVaultScanOptions } from './session-scanner-types'

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
  configureAiVaultSessionSources,
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

const EMPTY_RESULT: AiVaultListResult = {
  sessions: [],
  issues: [],
  scannedAt: '2026-08-05T00:00:00.000Z'
}

describe('cached Agent History source configuration', () => {
  beforeEach(() => {
    resetAiVaultSessionListCacheForTests()
    scanAiVaultSessionsInWorker.mockReset()
    scanAiVaultSessionsInWorker.mockResolvedValue(EMPTY_RESULT)
  })

  it('scans the configured host Codex session source alongside the default home', async () => {
    configureAiVaultSessionSources({
      getCodexSessionSourceHomePath: () => '/custom/codex/home',
      getAdditionalCodexHomePaths: () => ['/runtime/codex/home']
    })

    await listAiVaultSessions({ force: true })

    const options = scanAiVaultSessionsInWorker.mock.calls[0]?.[0] as AiVaultScanOptions
    expect(options.additionalCodexSessionsDirs).toEqual([
      join('/custom/codex/home', 'sessions'),
      join('/runtime/codex/home', 'sessions')
    ])
    // The override adds a root. Overriding codexSessionsDir instead would drop
    // the user's real ~/.codex history from the panel.
    expect(options.codexSessionsDir).toBeUndefined()
  })

  it('rescans immediately when the configured source changes', async () => {
    let sourceHome = '/custom/codex/a'
    configureAiVaultSessionSources({ getCodexSessionSourceHomePath: () => sourceHome })

    await listAiVaultSessions()
    sourceHome = '/custom/codex/b'
    await listAiVaultSessions()

    expect(scanAiVaultSessionsInWorker).toHaveBeenCalledTimes(2)
    expect(scanAiVaultSessionsInWorker.mock.calls[1]?.[0]).toMatchObject({
      additionalCodexSessionsDirs: [join('/custom/codex/b', 'sessions')]
    })
  })

  it('keys an equivalent source set identically regardless of order or duplicates', async () => {
    // The scan unions and de-dupes these roots, so a permutation cannot change
    // the result — and pointing the override at a root already in the list
    // (~/.codex is the field's own placeholder) must not evict the cache.
    let homes = ['/runtime/home', '/accounts/a/home']
    configureAiVaultSessionSources({ getAdditionalCodexHomePaths: () => homes })
    await listAiVaultSessions()
    homes = ['/accounts/a/home', '/runtime/home', '/runtime/home/']
    await listAiVaultSessions()

    expect(scanAiVaultSessionsInWorker).toHaveBeenCalledTimes(1)
  })

  it('still rescans when the source set genuinely changes', async () => {
    let homes = ['/runtime/home']
    configureAiVaultSessionSources({ getAdditionalCodexHomePaths: () => homes })
    await listAiVaultSessions()
    homes = ['/runtime/home', '/accounts/a/home']
    await listAiVaultSessions()

    expect(scanAiVaultSessionsInWorker).toHaveBeenCalledTimes(2)
  })

  it('does not join an in-flight scan for an older source', async () => {
    let sourceHome = '/custom/codex/a'
    const resolveScans: ((result: AiVaultListResult) => void)[] = []
    scanAiVaultSessionsInWorker.mockImplementation(
      () => new Promise<AiVaultListResult>((resolve) => resolveScans.push(resolve))
    )
    configureAiVaultSessionSources({ getCodexSessionSourceHomePath: () => sourceHome })

    const first = listAiVaultSessions()
    await vi.waitFor(() => expect(resolveScans).toHaveLength(1))
    sourceHome = '/custom/codex/b'
    const second = listAiVaultSessions()
    await vi.waitFor(() => expect(resolveScans).toHaveLength(2))

    // The point is not just that a second scan started, but that it started
    // against the NEW source rather than re-reading the superseded one.
    expect(scanAiVaultSessionsInWorker.mock.calls[1]?.[0]).toMatchObject({
      additionalCodexSessionsDirs: [join('/custom/codex/b', 'sessions')]
    })
    resolveScans.forEach((resolve) => resolve(EMPTY_RESULT))
    await Promise.all([first, second])
  })
})
