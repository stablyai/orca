import { mkdtempSync, readFileSync, rmSync } from 'node:fs'

import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { UsageStoreHost, UsageTelemetryHost } from '../usage-store-host'
import { createTestUsageStoreHost } from '../usage-store-host-test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageScanWorktreeRef } from './usage-provider-contract'
import { UsageProviderStoreLifecycle } from './usage-provider-store-lifecycle'
import {
  splitUsageCacheFile,
  type UsageCacheSplitRequest,
  type UsageCacheSplitResult,
  type UsageSourceCacheRef
} from '../cache/usage-source-cache-file'

type TestSource = { id: string }
type TestSession = { id: string }
type TestDailyAggregate = { day: string }
type TestScanState = {
  enabled: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
}
type TestState = {
  schemaVersion: number
  worktreeFingerprint: string | null
  processedSources: TestSource[]
  sessions: TestSession[]
  dailyAggregates: TestDailyAggregate[]
  scanState: TestScanState
}
type TestScanResult = Pick<TestState, 'sessions' | 'dailyAggregates'>
type TestScan = (
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
) => Promise<TestScanResult>
type TestSplit = (request: UsageCacheSplitRequest) => Promise<UsageCacheSplitResult>

const NOW = Date.parse('2026-04-10T16:00:00.000Z')

function makeState(
  overrides: Partial<Omit<TestState, 'scanState'>> & { scanState?: Partial<TestScanState> } = {}
): TestState {
  const { scanState, ...stateOverrides } = overrides
  return {
    schemaVersion: 1,
    worktreeFingerprint: null,
    processedSources: [],
    sessions: [],
    dailyAggregates: [],
    ...stateOverrides,
    scanState: {
      enabled: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null,
      ...scanState
    }
  }
}

function emptyScanResult(): TestScanResult {
  return { sessions: [], dailyAggregates: [] }
}

class TestUsageStore extends UsageProviderStoreLifecycle<
  'processedSources',
  TestState,
  'hasAnyTestData'
> {
  constructor(
    cacheFile: string,
    scan: TestScan,
    splitCacheFile: TestSplit,
    capture: ReturnType<typeof vi.fn<UsageTelemetryHost['capture']>>,
    readCatalog?: UsageStoreHost['readCatalog'],
    isEnabled?: UsageTelemetryHost['isEnabled'],
    signal?: AbortSignal
  ) {
    super(
      {
        ...createTestUsageStoreHost({
          userDataPath: dirname(cacheFile),
          telemetryEnabled: true,
          capture,
          signal
        }),
        ...(readCatalog ? { readCatalog } : {}),
        ...(isEnabled ? { telemetry: { isEnabled, capture } } : {})
      },
      {
        tokenUsage: {
          provider: 'claude',
          selectSessions: (state) =>
            state.sessions.map((session) => ({
              providerSessionId: session.id,
              input_tokens: 10,
              output_tokens: 2,
              cached_input_tokens: 3,
              cache_write_input_tokens: 1
            }))
        },
        logTag: '[test-usage]',
        resolveCacheFile: () => cacheFile,
        createDefaultState: makeState,
        normalizeState: (state) => state,
        sourceKey: 'processedSources',
        dataPresenceKey: 'hasAnyTestData',
        scan,
        splitCacheFile
      }
    )
  }

  replaceState(state: TestState): void {
    this.state = state
  }

  getState(): TestState {
    return this.state
  }
}

describe('UsageProviderStoreLifecycle', () => {
  let tempDirectory: string
  let stores: TestUsageStore[]
  let scan: ReturnType<typeof vi.fn<TestScan>>
  let split: ReturnType<typeof vi.fn<TestSplit>>
  let capture: ReturnType<typeof vi.fn<UsageTelemetryHost['capture']>>

  beforeEach(() => {
    capture = vi.fn<UsageTelemetryHost['capture']>(async () => true)
    tempDirectory = mkdtempSync(join(tmpdir(), 'orca-usage-lifecycle-'))
    stores = []
    scan = vi.fn<TestScan>().mockResolvedValue(emptyScanResult())
    // Run the real cache split in-process; the worker only wraps it in a thread.
    split = vi.fn<TestSplit>(splitUsageCacheFile)
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterEach(async () => {
    await Promise.all(stores.map((store) => store.flush()))
    rmSync(tempDirectory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it.each([100, 1000])('uses one consistent catalog per refresh at %i worktrees', async (count) => {
    const worktrees = Array.from({ length: count }, (_, i) => ({
      worktreeId: `repo::/work/${i}`,
      path: `/work/${i}`,
      displayName: `Work ${i}`
    }))
    const readCatalog = vi.fn<UsageStoreHost['readCatalog']>().mockResolvedValue({
      repoIds: ['repo'],
      worktreesByRepo: [['repo', worktrees]]
    })
    const store = new TestUsageStore(
      join(tempDirectory, 'catalog.json'),
      scan,
      split,
      capture,
      readCatalog
    )
    stores.push(store)
    await store.whenLoaded()
    await store.refresh(true)
    expect(readCatalog).not.toHaveBeenCalled()
    await store.setEnabled(true)
    const blocked = Promise.withResolvers<TestScanResult>()
    scan.mockReturnValueOnce(blocked.promise)
    const first = store.refresh(true)
    const second = store.refresh(true)
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1))
    expect(readCatalog).toHaveBeenCalledTimes(2)
    expect(scan.mock.calls[0][0]).toHaveLength(count)
    expect(scan.mock.calls[0][0][0]).toMatchObject({ path: '/work/0' })
    blocked.resolve({ sessions: [{ id: 'catalog-result' }], dailyAggregates: [] })
    await Promise.all([first, second])
    expect(store.getState().sessions).toEqual([{ id: 'catalog-result' }])
    readCatalog.mockClear()
    await store.refresh()
    expect(readCatalog).toHaveBeenCalledTimes(1)
    expect(scan).toHaveBeenCalledTimes(1)
    store.stopScanAdmission()
    readCatalog.mockClear()
    await store.refresh(true)
    expect(readCatalog).not.toHaveBeenCalled()
  })

  it('keeps a successful scan when the first async telemetry consent request rejects', async () => {
    const cacheFile = join(tempDirectory, 'consent-rejection.json')
    const consent = vi
      .fn<UsageTelemetryHost['isEnabled']>()
      .mockRejectedValue(new Error('No RPC credit'))
    const store = new TestUsageStore(cacheFile, scan, split, capture, undefined, consent)
    stores.push(store)
    await store.setEnabled(true)
    scan.mockResolvedValueOnce({
      sessions: [{ id: 'fresh' }],
      dailyAggregates: [{ day: '2026-04-10' }]
    })
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(store.refresh(true)).resolves.toMatchObject({
      isScanning: false,
      lastScanCompletedAt: NOW,
      lastScanError: null,
      hasAnyTestData: true
    })
    await store.flush()
    expect(store.getState().sessions).toEqual([{ id: 'fresh' }])
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({
      sessions: [{ id: 'fresh' }],
      dailyAggregates: [{ day: '2026-04-10' }],
      scanState: { lastScanCompletedAt: NOW, lastScanError: null }
    })
    expect(consent).toHaveBeenCalledTimes(1)
    expect(capture).not.toHaveBeenCalled()
  })

  it('stops admission without persisting a host catalog abort as a scan failure', async () => {
    const cacheFile = join(tempDirectory, 'aborted-catalog.json')
    const abort = new AbortController()
    const readCatalog = vi.fn<UsageStoreHost['readCatalog']>().mockResolvedValue({
      repoIds: ['repo-1'],
      worktreesByRepo: [
        ['repo-1', [{ worktreeId: 'repo-1::/workspace/a', path: '/workspace/a', displayName: 'A' }]]
      ]
    })
    const store = new TestUsageStore(
      cacheFile,
      scan,
      split,
      capture,
      readCatalog,
      undefined,
      abort.signal
    )
    stores.push(store)
    await store.setEnabled(true)
    scan.mockResolvedValueOnce({ sessions: [{ id: 'scan-result' }], dailyAggregates: [] })
    await store.refresh(true)
    expect(scan.mock.calls[0]?.[0]).toEqual([
      {
        repoId: 'repo-1',
        worktreeId: 'repo-1::/workspace/a',
        path: '/workspace/a',
        displayName: 'A'
      }
    ])
    const catalog = Promise.withResolvers<Awaited<ReturnType<UsageStoreHost['readCatalog']>>>()
    readCatalog.mockReturnValueOnce(catalog.promise)
    const refresh = store.refresh(true)
    abort.abort(new Error('Backend stopping'))
    catalog.resolve({ repoIds: [], worktreesByRepo: [] })
    await expect(refresh).rejects.toThrow('Backend stopping')
    store.stopScanAdmission()
    await store.refresh(true)
    await store.flush()
    expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({
      sessions: [{ id: 'scan-result' }],
      scanState: { enabled: true, lastScanError: null }
    })
  })
})
