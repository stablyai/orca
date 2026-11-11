import { mkdtempSync, readFileSync, rmSync } from 'node:fs'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  constructor(cacheFile: string, scan: TestScan, splitCacheFile: TestSplit) {
    super(
      {
        getRepos: () => [],
        getAllWorktreeMeta: () => ({})
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
}

describe('UsageProviderStoreLifecycle', () => {
  let tempDirectory: string
  let stores: TestUsageStore[]
  let scan: ReturnType<typeof vi.fn<TestScan>>
  let split: ReturnType<typeof vi.fn<TestSplit>>

  function createStore(
    cacheFile = join(tempDirectory, `usage-${stores.length}.json`)
  ): TestUsageStore {
    const store = new TestUsageStore(cacheFile, scan, split)
    stores.push(store)
    return store
  }

  beforeEach(() => {
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

  it('flush waits for queued analytics identity creation', async () => {
    const store = createStore()
    const identity = store.getAnalyticsSessionIds(['session'])
    await store.flush()
    const [id] = await identity
    expect(
      readFileSync(join(tempDirectory, 'usage-0-analytics-session-ids.json'), 'utf8')
    ).toContain(id)
  })

  it('keeps per-source records out of the report main writes', async () => {
    const cacheFile = join(tempDirectory, 'provider.json')
    const store = createStore(cacheFile)
    await store.setEnabled(true)
    scan.mockResolvedValueOnce({ sessions: [{ id: 'session' }], dailyAggregates: [] })

    await store.refresh(true)
    await store.flush()

    const persisted = readFileSync(cacheFile, 'utf-8')
    expect(JSON.parse(persisted)).not.toHaveProperty('processedSources')
    expect(JSON.parse(persisted).sessions).toEqual([{ id: 'session' }])
    expect(persisted).not.toContain('\n')
  })
})
