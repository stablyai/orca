import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { UsageProviderStoreLifecycle } from './usage-provider-store-lifecycle'
import { UsageCacheSnapshotWriter } from '../usage-cache-snapshot-writer'
import type { UsageScanWorktreeRef } from './usage-provider-contract'
import {
  usageSourceCachePath,
  type UsageCacheSplitRequest,
  type UsageCacheSplitResult,
  type UsageSourceCacheRef
} from './usage-source-cache-file'

const { identityWriteGate } = vi.hoisted(() => ({
  identityWriteGate: {
    prefix: '',
    pending: Promise.resolve(),
    entered: vi.fn()
  }
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (
        args[1] === 'w' &&
        identityWriteGate.prefix &&
        String(args[0]).startsWith(identityWriteGate.prefix)
      ) {
        identityWriteGate.entered()
        await identityWriteGate.pending
      }
      return actual.open(...args)
    }
  }
})

type TestState = {
  schemaVersion: number
  worktreeFingerprint: string | null
  processedSources: { id: string }[]
  sessions: { id: string }[]
  dailyAggregates: { day: string }[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}
type ScanProjection = Pick<TestState, 'sessions' | 'dailyAggregates'>
type Scan = (
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
) => Promise<ScanProjection>
type Split = (request: UsageCacheSplitRequest) => Promise<UsageCacheSplitResult>
type LoadOptions = {
  splitCacheFile: Split
  scan?: Scan
  parseReport?: (text: string) => TestState | Promise<TestState>
  serializeReport?: (state: TestState) => string
}

function defaultState(): TestState {
  return {
    schemaVersion: 1,
    worktreeFingerprint: null,
    processedSources: [],
    sessions: [],
    dailyAggregates: [],
    scanState: {
      enabled: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null
    }
  }
}

function historicalState(enabled = false): TestState {
  return {
    ...defaultState(),
    worktreeFingerprint: '[]',
    processedSources: [{ id: 'historical-source' }],
    sessions: [{ id: 'historical-session' }],
    dailyAggregates: [{ day: '2026-10-09' }],
    scanState: { ...defaultState().scanState, enabled, lastScanCompletedAt: 1 }
  }
}

function reportState(state: TestState): TestState {
  return { ...state, processedSources: [] }
}

function reportText(state: TestState): string {
  const { processedSources: _sources, ...report } = state
  return JSON.stringify(report)
}

class LoadingUsageStore extends UsageProviderStoreLifecycle<
  'processedSources',
  TestState,
  'hasAnyTestData'
> {
  constructor(cacheFile: string, options: LoadOptions) {
    super(
      { getRepos: () => [], getAllWorktreeMeta: () => ({}) },
      {
        logTag: '[test-loading-usage]',
        resolveCacheFile: () => cacheFile,
        createDefaultState: defaultState,
        normalizeState: (state) => state,
        sourceKey: 'processedSources',
        dataPresenceKey: 'hasAnyTestData',
        scan: options.scan ?? (async () => defaultState()),
        splitCacheFile: options.splitCacheFile,
        parseReport: options.parseReport,
        serializeReport: options.serializeReport
      }
    )
  }

  getSnapshot(): TestState {
    return structuredClone(this.state)
  }
}

let directory: string
let cacheFile: string
let stores: LoadingUsageStore[]
let releasePending: (() => void)[]

function createStore(options: LoadOptions): LoadingUsageStore {
  const store = new LoadingUsageStore(cacheFile, options)
  stores.push(store)
  return store
}

function writeLargeLegacyCache(state: TestState): string {
  const payload = `${JSON.stringify(state)}${' '.repeat(9 * 1024 * 1024)}`
  writeFileSync(cacheFile, payload)
  return payload
}

function pendingSplit(state: TestState, migrated = false) {
  const pending = Promise.withResolvers<UsageCacheSplitResult>()
  releasePending.push(() => pending.resolve({ reportText: reportText(state), migrated }))
  return pending
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'orca-usage-loading-'))
  cacheFile = join(directory, 'usage.json')
  stores = []
  releasePending = []
  identityWriteGate.prefix = ''
  identityWriteGate.pending = Promise.resolve()
  identityWriteGate.entered.mockClear()
})

afterEach(async () => {
  releasePending.forEach((release) => release())
  await Promise.all(stores.map((store) => store.flush()))
  rmSync(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('withholds a large disabled history until whenLoaded and retains no source graph', async () => {
  const cached = historicalState()
  writeLargeLegacyCache(cached)
  const pending = pendingSplit(cached)
  const split = vi.fn<Split>(() => pending.promise)
  const store = createStore({ splitCacheFile: split })
  const ready = vi.fn()
  const loaded = store.whenLoaded().then(ready)
  expect(store.getSnapshot()).toMatchObject({ sessions: [], dailyAggregates: [] })
  await nextTurn()
  expect(split).toHaveBeenCalledWith(
    expect.objectContaining({ cacheFile, sourceKey: 'processedSources' })
  )
  expect(ready).not.toHaveBeenCalled()
  pending.resolve({ reportText: reportText(cached), migrated: false })
  await loaded
  expect(store.getSnapshot()).toEqual(reportState(cached))
  expect(store.getScanState()).toMatchObject({ enabled: false, hasAnyTestData: true })
  expect(JSON.stringify(store.getSnapshot())).not.toContain('historical-source')
})

it('queues enabled changes and flush behind loading without writing provisional state', async () => {
  const cached = historicalState()
  const initialPayload = writeLargeLegacyCache(cached)
  const pending = pendingSplit(cached, true)
  const serialize = vi.fn((state: TestState) => {
    const { processedSources: _sources, ...report } = state
    return JSON.stringify({ ...report, serialized: true })
  })
  const store = createStore({ splitCacheFile: () => pending.promise, serializeReport: serialize })
  const enable = store.setEnabled(true)
  const disable = store.setEnabled(false)
  const finalEnable = store.setEnabled(true)
  const flushed = vi.fn()
  const flush = store.flush().then(flushed)
  await nextTurn()
  expect(serialize).not.toHaveBeenCalled()
  expect(flushed).not.toHaveBeenCalled()
  expect(readFileSync(cacheFile, 'utf8')).toBe(initialPayload)
  pending.resolve({ reportText: reportText(cached), migrated: true })
  await flush
  expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject({
    sessions: cached.sessions,
    scanState: { enabled: true },
    serialized: true
  })
  await Promise.all([enable, disable, finalEnable])
  expect(store.getSnapshot()).toEqual({
    ...reportState(cached),
    scanState: { ...cached.scanState, enabled: true }
  })
  expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).not.toHaveProperty('processedSources')
})

it('admits a shared refresh after loading and keeps the newer worker projection', async () => {
  const cached = historicalState(true)
  writeLargeLegacyCache(cached)
  const pending = pendingSplit(cached)
  const scanPending = Promise.withResolvers<ScanProjection>()
  releasePending.push(() => scanPending.resolve(defaultState()))
  const scan = vi.fn<Scan>(() => scanPending.promise)
  const store = createStore({ splitCacheFile: () => pending.promise, scan })
  const first = store.refresh(true)
  const second = store.refresh(true)
  await nextTurn()
  expect(scan).not.toHaveBeenCalled()
  pending.resolve({ reportText: reportText(cached), migrated: false })
  await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1))
  expect(scan).toHaveBeenCalledWith([], {
    path: usageSourceCachePath(cacheFile),
    schemaVersion: 1,
    worktreeFingerprint: '[]',
    reuse: true
  })
  const newer = { sessions: [{ id: 'new-session' }], dailyAggregates: [{ day: '2026-10-10' }] }
  const workerReply = { ...newer, processedSources: [{ id: 'worker-source-graph' }] }
  scanPending.resolve(workerReply)
  await Promise.all([first, second])
  await store.whenLoaded()
  await nextTurn()
  expect(store.getSnapshot()).toMatchObject({ ...newer, processedSources: [] })
  expect(JSON.stringify(store.getSnapshot())).not.toContain('worker-source-graph')
  expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toMatchObject(newer)
  expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).not.toHaveProperty('processedSources')
})

it('honors a queued disable before a queued refresh starts after loading', async () => {
  const cached = historicalState(true)
  writeLargeLegacyCache(cached)
  const pending = pendingSplit(cached)
  const scan = vi.fn<Scan>(async () => defaultState())
  const store = createStore({ splitCacheFile: () => pending.promise, scan })
  const disable = store.setEnabled(false)
  const refresh = store.refresh(true)
  pending.resolve({ reportText: reportText(cached), migrated: false })
  await Promise.all([disable, refresh])
  expect(scan).not.toHaveBeenCalled()
  expect(store.getSnapshot()).toMatchObject({
    sessions: cached.sessions,
    scanState: { enabled: false }
  })
})

it.each(['rejection', 'throw'] as const)(
  'preserves disabled cached history after a worker %s',
  async (failureMode) => {
    const cached = historicalState()
    writeLargeLegacyCache(cached)
    const failure = new Error('usage worker unavailable')
    const unhandled = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.on('unhandledRejection', unhandled)
    try {
      const store = createStore({
        splitCacheFile: () => {
          if (failureMode === 'throw') {
            throw failure
          }
          return Promise.reject(failure)
        }
      })
      await expect(store.whenLoaded()).resolves.toBeUndefined()
      await nextTurn()
      expect(unhandled).not.toHaveBeenCalled()
      expect(store.getSnapshot()).toEqual(reportState(cached))
      expect(store.getScanState()).toMatchObject({ enabled: false, hasAnyTestData: true })
      expect(store.getSnapshot().processedSources).toEqual([])
      await store.setEnabled(true)
      await store.flush()
      expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).toEqual({
        ...cached,
        scanState: { ...cached.scanState, enabled: true }
      })
      expect(store.getSnapshot().processedSources).toEqual([])
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  }
)

it('keeps an ordinary compact report synchronous and never asks the worker to split it', async () => {
  const cached = historicalState()
  writeFileSync(cacheFile, reportText(cached))
  const split = vi.fn<Split>()
  const store = createStore({ splitCacheFile: split })
  expect(store.getSnapshot()).toEqual(reportState(cached))
  expect(split).not.toHaveBeenCalled()
  await store.setEnabled(true)
  expect(JSON.parse(readFileSync(cacheFile, 'utf8'))).not.toHaveProperty('processedSources')
})

it('extends whenLoaded through an asynchronous provider report parser', async () => {
  const cached = historicalState()
  writeFileSync(cacheFile, reportText(cached))
  const parsed = Promise.withResolvers<TestState>()
  releasePending.push(() => parsed.resolve(reportState(cached)))
  const parseReport = vi.fn(() => parsed.promise)
  const store = createStore({ splitCacheFile: vi.fn<Split>(), parseReport })
  const ready = vi.fn()
  const loaded = store.whenLoaded().then(ready)
  const enabled = store.setEnabled(true)
  await nextTurn()
  expect(ready).not.toHaveBeenCalled()
  expect(readFileSync(cacheFile, 'utf8')).toBe(reportText(cached))
  parsed.resolve(reportState(cached))
  await Promise.all([loaded, enabled])
  expect(store.getSnapshot()).toMatchObject({
    sessions: cached.sessions,
    scanState: { enabled: true }
  })
})

it('drains the pending analytics writer after an inline preference write rejects', async () => {
  const cached = historicalState()
  writeLargeLegacyCache(cached)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const store = createStore({
    splitCacheFile: async () => {
      throw new Error('usage worker unavailable')
    }
  })
  await store.whenLoaded()
  rmSync(cacheFile)
  await expect(store.setEnabled(true)).rejects.toMatchObject({ code: 'ENOENT' })
  const identityFile = join(directory, 'usage-analytics-session-ids.json')
  const pending = Promise.withResolvers<void>()
  releasePending.push(() => pending.resolve(undefined))
  identityWriteGate.prefix = identityFile
  identityWriteGate.pending = pending.promise
  const identity = store.getAnalyticsSessionIds(['session-with-pending-identity'])
  await vi.waitFor(() => expect(identityWriteGate.entered).toHaveBeenCalledTimes(1))
  const writerFlush = vi.spyOn(UsageCacheSnapshotWriter.prototype, 'flush')
  const flushed = vi.fn()
  const flushing = store.flush().then(flushed)
  await nextTurn()
  expect(writerFlush).toHaveBeenCalled()
  expect(flushed).not.toHaveBeenCalled()
  pending.resolve(undefined)
  await expect(flushing).resolves.toBeUndefined()
  const [id] = await identity
  expect(JSON.parse(readFileSync(identityFile, 'utf8'))).toMatchObject({
    entries: [['session-with-pending-identity', id]]
  })
  expect(writerFlush).toHaveBeenCalledTimes(2)
  expect(store.getSnapshot().processedSources).toEqual([])
})
