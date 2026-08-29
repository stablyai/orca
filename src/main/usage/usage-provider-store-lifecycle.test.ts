import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageScanWorktreeRef } from './usage-provider-contract'
import { UsageProviderStoreLifecycle } from './usage-provider-store-lifecycle'

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
type TestScanResult = Pick<TestState, 'processedSources' | 'sessions' | 'dailyAggregates'>
type TestScan = (
  worktrees: UsageScanWorktreeRef[],
  previous: TestSource[]
) => Promise<TestScanResult>

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
  return { processedSources: [], sessions: [], dailyAggregates: [] }
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
  constructor(cacheFile: string, scan: TestScan) {
    super(
      {
        getRepos: () => [],
        getAllWorktreeMeta: () => ({})
      },
      {
        logTag: '[test-usage]',
        resolveCacheFile: () => cacheFile,
        createDefaultState: makeState,
        normalizeState: (state) => state,
        sourceKey: 'processedSources',
        dataPresenceKey: 'hasAnyTestData',
        scan
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

  function createStore(
    cacheFile = join(tempDirectory, `usage-${stores.length}.json`)
  ): TestUsageStore {
    const store = new TestUsageStore(cacheFile, scan)
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
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
  })

  afterEach(async () => {
    await Promise.all(stores.map((store) => store.flush()))
    rmSync(tempDirectory, { recursive: true, force: true })
    vi.restoreAllMocks()
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
    const refreshedSources = [{ id: 'refreshed' }]
    scan.mockResolvedValueOnce({
      processedSources: refreshedSources,
      sessions: [],
      dailyAggregates: []
    })
    store.replaceState(
      makeState({
        worktreeFingerprint: 'outdated',
        processedSources: [{ id: 'stale' }],
        scanState: { enabled: true, lastScanCompletedAt: NOW - 1 }
      })
    )

    await store.refresh()
    expect(scan).toHaveBeenLastCalledWith([], [])

    scan.mockClear()
    await store.refresh(true)

    expect(scan).toHaveBeenCalledWith([], refreshedSources)
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
      processedSources: [{ id: 'source' }],
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
    expect(store.getState().processedSources).toEqual([{ id: 'source' }])
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
      processedSources: [{ id: 'source' }],
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
      processedSources: previousState.processedSources,
      sessions: previousState.sessions,
      dailyAggregates: previousState.dailyAggregates
    })
    expect(JSON.parse(readFileSync(cacheFile, 'utf-8')).scanState.lastScanError).toBe(
      'scan exploded'
    )
  })
})
