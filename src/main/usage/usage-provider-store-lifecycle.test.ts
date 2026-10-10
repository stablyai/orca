import {
  setupTelemetryClientTest,
  cleanupTelemetryClientTest
} from '../telemetry/client-test-harness'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
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
} from './usage-source-cache-file'

const { writeProbe } = vi.hoisted(() => ({
  writeProbe: {
    opens: 0,
    renames: 0,
    blocked: false,
    waiters: [] as (() => void)[]
  }
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      if (args[1] === 'w') {
        writeProbe.opens += 1
        if (writeProbe.blocked) {
          await new Promise<void>((resolve) => writeProbe.waiters.push(resolve))
        }
      }
      return actual.open(...args)
    }) as typeof actual.open,
    rename: ((...args: Parameters<typeof actual.rename>) => {
      writeProbe.renames += 1
      return actual.rename(...args)
    }) as typeof actual.rename
  }
})

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
const EMPTY_WORKTREE_FINGERPRINT = '[]'

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

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
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
    writeProbe.opens = 0
    writeProbe.renames = 0
    writeProbe.blocked = false
    writeProbe.waiters = []
    scan = vi.fn<TestScan>().mockResolvedValue(emptyScanResult())
    // The real split, in-process: the worker only adds the thread around it.
    split = vi.fn<TestSplit>(splitUsageCacheFile)
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterEach(async () => {
    await Promise.all(stores.map((store) => store.flush()))
    rmSync(tempDirectory, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('reports enabled scans and preserves revisions when the usage cache is rebuilt', async () => {
    const telemetry = setupTelemetryClientTest()
    try {
      const cacheFile = join(tempDirectory, 'provider.json')
      scan.mockResolvedValue({ ...emptyScanResult(), sessions: [{ id: 'provider-session' }] })
      const original = createStore(cacheFile)
      await original.refresh(true)
      expect(telemetry.mock.capture).not.toHaveBeenCalled()
      await original.setEnabled(true)
      await original.refresh(true)
      const first = telemetry.mock.capture.mock.calls[0]?.[0]
      expect(first).toMatchObject({
        event: 'agent_token_usage',
        properties: { revision: 1, input_tokens: 10 }
      })
      await original.flush()
      rmSync(cacheFile)
      const rebuilt = createStore(cacheFile)
      await rebuilt.setEnabled(true)
      await rebuilt.refresh(true)
      expect(telemetry.mock.capture.mock.calls[1]?.[0]).toEqual(first)
    } finally {
      cleanupTelemetryClientTest(telemetry.envStash)
    }
  })

  it('persists identities for a whole first scan with one write', async () => {
    const telemetry = setupTelemetryClientTest()
    try {
      const sessions = Array.from({ length: 20 }, (_, index) => ({ id: `session-${index}` }))
      scan.mockResolvedValue({ ...emptyScanResult(), sessions })
      const store = createStore(join(tempDirectory, 'provider.json'))
      await store.setEnabled(true)
      writeProbe.opens = 0
      await store.refresh(true)
      // Usage cache, identity file, and token-usage snapshot: one write each.
      expect(writeProbe.opens).toBe(3)
      expect(telemetry.mock.capture).toHaveBeenCalledTimes(sessions.length)
    } finally {
      cleanupTelemetryClientTest(telemetry.envStash)
    }
  })

  it('keeps analytics identity separate from usage cache rebuilds and never puts it in snapshots', async () => {
    const cacheFile = join(tempDirectory, 'provider.json')
    const identityFile = join(tempDirectory, 'provider-analytics-session-ids.json')
    const original = createStore(cacheFile)
    expect(existsSync(identityFile)).toBe(false)
    const [id] = await original.getAnalyticsSessionIds(['provider-session'])
    expect(existsSync(identityFile)).toBe(true)
    await original.setEnabled(true)
    await original.refresh(true)
    await original.flush()
    expect(JSON.stringify(original.getState())).not.toContain(id)
    expect(readFileSync(cacheFile, 'utf8')).not.toContain(id)
    rmSync(cacheFile)
    const rebuilt = createStore(cacheFile)
    expect(await rebuilt.getAnalyticsSessionIds(['provider-session'])).toEqual([id])
    expect(await createStore().getAnalyticsSessionIds(['provider-session'])).not.toEqual([id])
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

  it('skips disabled and fresh matching states', async () => {
    const store = createStore()

    await store.refresh()
    expect(scan).not.toHaveBeenCalled()

    store.replaceState(
      makeState({
        worktreeFingerprint: EMPTY_WORKTREE_FINGERPRINT,
        scanState: { enabled: true, lastScanCompletedAt: NOW - 1 }
      })
    )
    await store.refresh()

    expect(scan).not.toHaveBeenCalled()
  })

  it('invalidates prior sources on fingerprint changes and reuses them for forced scans', async () => {
    const store = createStore()
    const sourceCache = {
      path: join(tempDirectory, 'usage-0-sources.json'),
      schemaVersion: 1,
      worktreeFingerprint: EMPTY_WORKTREE_FINGERPRINT
    }
    store.replaceState(
      makeState({
        worktreeFingerprint: 'outdated',
        scanState: { enabled: true, lastScanCompletedAt: NOW - 1 }
      })
    )

    await store.refresh()
    expect(scan).toHaveBeenLastCalledWith([], { ...sourceCache, reuse: false })

    scan.mockClear()
    await store.refresh(true)

    expect(scan).toHaveBeenCalledWith([], { ...sourceCache, reuse: true })
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
    // Compact: the report is rewritten after every scan.
    expect(persisted).not.toContain('\n')
  })

  it('preserves a small legacy cache for the next warm scan', async () => {
    const cacheFile = join(tempDirectory, 'provider.json')
    writeFileSync(
      cacheFile,
      JSON.stringify(
        makeState({
          worktreeFingerprint: EMPTY_WORKTREE_FINGERPRINT,
          processedSources: [{ id: 'inline' }],
          sessions: [{ id: 'session' }]
        })
      )
    )

    const store = createStore(cacheFile)

    await store.whenLoaded()
    expect(split).toHaveBeenCalledWith({ cacheFile, sourceKey: 'processedSources' })
    expect(store.getState().sessions).toEqual([{ id: 'session' }])
    expect(store.getState().processedSources).toEqual([])
    expect(
      JSON.parse(readFileSync(join(tempDirectory, 'provider-sources.json'), 'utf-8'))
    ).toMatchObject({
      sources: [{ id: 'inline' }]
    })
  })

  it('splits a large legacy cache on the worker before any reader or writer sees it', async () => {
    const cacheFile = join(tempDirectory, 'provider.json')
    // Past the main-thread parse ceiling, the shape a pre-sidecar Claude history has.
    const processedSources = Array.from({ length: 9_000 }, (_, index) => ({
      id: `source-${index}-${'x'.repeat(1_000)}`
    }))
    writeFileSync(
      cacheFile,
      JSON.stringify(
        makeState({
          worktreeFingerprint: EMPTY_WORKTREE_FINGERPRINT,
          processedSources,
          sessions: [{ id: 'session' }],
          scanState: { enabled: true, lastScanCompletedAt: NOW - 1 }
        }),
        null,
        2
      )
    )

    const store = createStore(cacheFile)
    // A write racing the load must not clobber the history being loaded.
    const disabled = store.setEnabled(false)

    expect(split).toHaveBeenCalledWith({ cacheFile, sourceKey: 'processedSources' })
    await store.whenLoaded()
    await disabled
    await store.flush()
    expect(store.getState().sessions).toEqual([{ id: 'session' }])
    expect(store.getState().processedSources).toEqual([])
    const report = JSON.parse(readFileSync(cacheFile, 'utf-8'))
    expect(report).not.toHaveProperty('processedSources')
    expect(report).toMatchObject({ sessions: [{ id: 'session' }], scanState: { enabled: false } })
    const sidecar = JSON.parse(readFileSync(join(tempDirectory, 'provider-sources.json'), 'utf-8'))
    expect(sidecar).toEqual({
      schemaVersion: 1,
      worktreeFingerprint: EMPTY_WORKTREE_FINGERPRINT,
      sources: processedSources
    })
  })

  it('reads a large cache on the main thread when the worker cannot split it', async () => {
    const cacheFile = join(tempDirectory, 'provider.json')
    writeFileSync(
      cacheFile,
      JSON.stringify(
        makeState({
          sessions: [{ id: 'session' }],
          processedSources: [{ id: 'x'.repeat(9 * 1024 * 1024) }]
        })
      )
    )
    split.mockRejectedValueOnce(new Error('worker unavailable'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = createStore(cacheFile)
    await store.whenLoaded()

    expect(store.getState().sessions).toEqual([{ id: 'session' }])
    expect(store.getState().processedSources).toEqual([])
  })

  it('flush waits for a pending migration and its report rewrite', async () => {
    const cacheFile = join(tempDirectory, 'provider.json')
    writeFileSync(
      cacheFile,
      JSON.stringify(makeState({ processedSources: [{ id: 'inline' }] })) +
        ' '.repeat(9 * 1024 * 1024)
    )
    const pendingSplit = createDeferred<UsageCacheSplitResult>()
    split.mockReturnValueOnce(pendingSplit.promise)
    const store = createStore(cacheFile)
    let flushed = false
    const flushing = store.flush().then(() => {
      flushed = true
    })

    await new Promise((resolve) => setImmediate(resolve))
    expect(flushed).toBe(false)
    pendingSplit.resolve({ reportText: JSON.stringify(makeState()), migrated: true })
    await flushing

    expect(JSON.parse(readFileSync(cacheFile, 'utf-8'))).not.toHaveProperty('processedSources')
  })

  it('shares one in-flight scan and exposes its live state', async () => {
    const pendingScan = createDeferred<TestScanResult>()
    scan.mockReturnValueOnce(pendingScan.promise)
    const store = createStore()
    store.replaceState(
      makeState({ scanState: { enabled: true, lastScanError: 'previous failure' } })
    )

    const firstRefresh = store.refresh(true)
    const secondRefresh = store.refresh(true)
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1))

    expect(store.getScanState()).toMatchObject({
      isScanning: true,
      lastScanStartedAt: NOW,
      lastScanError: null
    })
    expect(writeProbe.opens).toBe(0)

    pendingScan.resolve({
      sessions: [{ id: 'session' }],
      dailyAggregates: []
    })
    await Promise.all([firstRefresh, secondRefresh])

    expect(store.getScanState()).toMatchObject({
      isScanning: false,
      lastScanCompletedAt: NOW,
      hasAnyTestData: true
    })
    expect(writeProbe.opens).toBe(1)
    expect(store.getState().sessions).toEqual([{ id: 'session' }])
  })

  it('vetoes a superseded generation before rename', async () => {
    const cacheFile = join(tempDirectory, 'usage-0.json')
    const store = createStore()

    writeProbe.blocked = true
    const first = store.setEnabled(true)
    await vi.waitFor(() => expect(writeProbe.waiters).toHaveLength(1))
    const second = store.setEnabled(false)
    writeProbe.blocked = false
    writeProbe.waiters.splice(0).forEach((resolve) => resolve())
    await Promise.all([first, second])

    expect(writeProbe.opens).toBe(2)
    expect(writeProbe.renames).toBe(1)
    expect(JSON.parse(readFileSync(cacheFile, 'utf-8')).scanState.enabled).toBe(false)
    expect(readdirSync(tempDirectory).filter((name) => name.endsWith('.tmp'))).toHaveLength(0)
  })

  it('sweeps a temp file orphaned before rename', async () => {
    const cacheFile = join(tempDirectory, 'orphaned-usage.json')
    const orphan = `${cacheFile}.${process.pid + 1}.1.test.tmp`
    writeFileSync(orphan, '{}')

    createStore(cacheFile)

    await vi.waitFor(() => expect(existsSync(orphan)).toBe(false))
  })

  it('retains the last successful projection when a scan fails', async () => {
    const cacheFile = join(tempDirectory, 'usage-0.json')
    const store = createStore()
    const previousState = makeState({
      worktreeFingerprint: EMPTY_WORKTREE_FINGERPRINT,
      sessions: [{ id: 'session' }],
      dailyAggregates: [{ day: '2026-04-09' }],
      scanState: { enabled: true, lastScanCompletedAt: NOW - 1_000 }
    })
    store.replaceState(previousState)
    scan.mockRejectedValueOnce(new Error('scan exploded'))

    await expect(store.refresh(true)).resolves.toMatchObject({
      isScanning: false,
      lastScanCompletedAt: NOW - 1_000,
      lastScanError: 'scan exploded'
    })

    expect(store.getState()).toMatchObject({
      worktreeFingerprint: EMPTY_WORKTREE_FINGERPRINT,
      sessions: previousState.sessions,
      dailyAggregates: previousState.dailyAggregates
    })
    expect(JSON.parse(readFileSync(cacheFile, 'utf-8')).scanState.lastScanError).toBe(
      'scan exploded'
    )
  })
})
