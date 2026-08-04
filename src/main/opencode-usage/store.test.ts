import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OpenCodeUsageDailyAggregate,
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsagePersistedState,
  OpenCodeUsageSession
} from './types'

const { getPathMock, writeOpens, writeGate } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata'),
  // Why only mode 'w': the durable write also opens the directory read-only to fsync it, so counting
  // every open would hide a regression back to multiple full-cache rewrites per scan.
  writeOpens: { value: 0, inFlight: 0, maxConcurrent: 0 },
  writeGate: {
    blocked: false,
    waiters: [] as (() => void)[]
  }
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return {
    ...actual,
    open: (async (...args: Parameters<typeof actual.open>) => {
      if (args[1] !== 'w') {
        return actual.open(...args)
      }
      writeOpens.value += 1
      writeOpens.inFlight += 1
      writeOpens.maxConcurrent = Math.max(writeOpens.maxConcurrent, writeOpens.inFlight)
      try {
        if (writeGate.blocked) {
          await new Promise<void>((resolve) => writeGate.waiters.push(resolve))
        }
        return await actual.open(...args)
      } finally {
        writeOpens.inFlight -= 1
      }
    }) as typeof actual.open
  }
})

vi.mock('./scanner', () => ({
  scanOpenCodeUsageDatabases: vi.fn()
}))

import { OpenCodeUsageStore, initOpenCodeUsagePath, normalizePersistedState } from './store'
import { scanOpenCodeUsageDatabases } from './scanner'

type ScanResult = {
  processedDatabases: OpenCodeUsagePersistedDatabase[]
  sessions: OpenCodeUsageSession[]
  dailyAggregates: OpenCodeUsageDailyAggregate[]
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

function createEmptyScanResult(): ScanResult {
  return {
    processedDatabases: [],
    sessions: [],
    dailyAggregates: []
  }
}

function getDefaultState(): OpenCodeUsagePersistedState {
  return {
    schemaVersion: 2,
    worktreeFingerprint: null,
    processedDatabases: [],
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

function createStoreWithState(state: Partial<OpenCodeUsagePersistedState>): OpenCodeUsageStore {
  const store = new OpenCodeUsageStore({
    getRepos: () => [],
    getAllWorktreeMeta: () => ({}),
    getWorktreeMeta: () => undefined
  } as never)

  ;(store as unknown as { state: OpenCodeUsagePersistedState }).state = {
    ...getDefaultState(),
    ...state
  }

  return store
}

function makeSession(overrides: Partial<OpenCodeUsageSession> = {}): OpenCodeUsageSession {
  const worktreeId = overrides.primaryWorktreeId ?? 'repo-1::/workspace/repo'
  const repoId = overrides.primaryRepoId ?? 'repo-1'
  const projectLabel = overrides.primaryProjectLabel ?? 'Repo'
  const model = overrides.primaryModel ?? 'anthropic/claude-sonnet-4-5'
  return {
    sessionId: 'session-1',
    firstTimestamp: '2026-04-09T10:00:00.000Z',
    lastTimestamp: '2026-04-09T10:10:00.000Z',
    primaryModel: model,
    hasMixedModels: false,
    primaryProjectLabel: projectLabel,
    hasMixedLocations: false,
    primaryWorktreeId: worktreeId,
    primaryRepoId: repoId,
    eventCount: 1,
    totalInputTokens: 1000,
    totalCachedInputTokens: 400,
    totalOutputTokens: 250,
    totalReasoningOutputTokens: 100,
    totalTokens: 1350,
    estimatedCostUsd: 0.05,
    locationBreakdown: [
      {
        locationKey: worktreeId ? `worktree:${worktreeId}` : 'cwd:/outside/repo',
        projectLabel,
        repoId,
        worktreeId,
        eventCount: 1,
        inputTokens: 1000,
        cachedInputTokens: 400,
        outputTokens: 250,
        reasoningOutputTokens: 100,
        totalTokens: 1350,
        estimatedCostUsd: 0.05
      }
    ],
    modelBreakdown: [
      {
        modelKey: model ?? 'unknown',
        modelLabel: model ?? 'Unknown model',
        eventCount: 1,
        inputTokens: 1000,
        cachedInputTokens: 400,
        outputTokens: 250,
        reasoningOutputTokens: 100,
        totalTokens: 1350,
        estimatedCostUsd: 0.05
      }
    ],
    locationModelBreakdown: [
      {
        locationKey: worktreeId ? `worktree:${worktreeId}` : 'cwd:/outside/repo',
        modelKey: model ?? 'unknown',
        modelLabel: model ?? 'Unknown model',
        repoId,
        worktreeId,
        eventCount: 1,
        inputTokens: 1000,
        cachedInputTokens: 400,
        outputTokens: 250,
        reasoningOutputTokens: 100,
        totalTokens: 1350,
        estimatedCostUsd: 0.05
      }
    ],
    ...overrides
  }
}

function makeDaily(
  overrides: Partial<OpenCodeUsageDailyAggregate> = {}
): OpenCodeUsageDailyAggregate {
  const worktreeId = overrides.worktreeId ?? 'repo-1::/workspace/repo'
  return {
    day: '2026-04-09',
    model: 'anthropic/claude-sonnet-4-5',
    projectKey: worktreeId ? `worktree:${worktreeId}` : 'cwd:/outside/repo',
    projectLabel: worktreeId ? 'Repo' : 'outside/repo',
    repoId: worktreeId ? 'repo-1' : null,
    worktreeId,
    eventCount: 1,
    inputTokens: 1000,
    cachedInputTokens: 400,
    outputTokens: 250,
    reasoningOutputTokens: 100,
    totalTokens: 1350,
    estimatedCostUsd: 0.05,
    ...overrides
  }
}

describe('OpenCodeUsageStore', () => {
  let tempUserData: string

  beforeEach(() => {
    tempUserData = mkdtempSync(join(tmpdir(), 'orca-opencode-usage-store-'))
    getPathMock.mockReturnValue(tempUserData)
    initOpenCodeUsagePath()
    writeOpens.value = 0
    writeOpens.inFlight = 0
    writeOpens.maxConcurrent = 0
    writeGate.blocked = false
    writeGate.waiters = []
    vi.mocked(scanOpenCodeUsageDatabases).mockReset()
    vi.mocked(scanOpenCodeUsageDatabases).mockResolvedValue(createEmptyScanResult())
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-10T12:00:00.000-04:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(tempUserData, { recursive: true, force: true })
  })

  it('persists a successful refresh with one full-cache write', async () => {
    const store = createStoreWithState({
      scanState: {
        enabled: true,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null
      }
    })

    await store.refresh(true)

    // Why exactly one: a refresh that rewrites the whole multi-MB cache twice is the regression this guards.
    expect(writeOpens.value).toBe(1)
    expect(readdirSync(tempUserData).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
    const persistedJson = readFileSync(join(tempUserData, 'orca-opencode-usage.json'), 'utf-8')
    expect(persistedJson).toContain('\n')
    expect(JSON.parse(persistedJson).scanState).toMatchObject({
      enabled: true,
      lastScanStartedAt: new Date('2026-04-10T12:00:00.000-04:00').getTime(),
      lastScanCompletedAt: new Date('2026-04-10T12:00:00.000-04:00').getTime(),
      lastScanError: null
    })
  })

  it('keeps scan start visible in memory while scan-start persistence is skipped', async () => {
    const pendingScan = createDeferred<ScanResult>()
    vi.mocked(scanOpenCodeUsageDatabases).mockReturnValueOnce(pendingScan.promise)
    const store = createStoreWithState({
      scanState: {
        enabled: true,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: 'previous failure'
      }
    })

    const refreshPromise = store.refresh(true)
    await Promise.resolve()

    expect(store.getScanState()).toMatchObject({
      isScanning: true,
      lastScanStartedAt: new Date('2026-04-10T12:00:00.000-04:00').getTime(),
      lastScanError: null
    })
    expect(writeOpens.value).toBe(0)

    pendingScan.resolve(createEmptyScanResult())
    await refreshPromise

    expect(store.getScanState().isScanning).toBe(false)
    expect(writeOpens.value).toBe(1)
  })

  it('vetoes a stale concurrent async write so the newer snapshot wins without leaking tmp files', async () => {
    const store = createStoreWithState({
      scanState: {
        enabled: true,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null
      }
    })
    const internals = store as unknown as {
      writeToDisk: () => Promise<void>
      state: OpenCodeUsagePersistedState
    }

    writeGate.blocked = true
    const first = internals.writeToDisk()
    await vi.waitFor(() => expect(writeGate.waiters.length).toBe(1))

    internals.state.scanState.enabled = false
    writeGate.blocked = false
    const second = internals.writeToDisk()
    writeGate.waiters.splice(0).forEach((resolve) => resolve())
    await Promise.all([first, second])

    expect(
      JSON.parse(readFileSync(join(tempUserData, 'orca-opencode-usage.json'), 'utf-8')).scanState
        .enabled
    ).toBe(false)
    expect(readdirSync(tempUserData).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
    // Serialized, so the superseded write can be skipped safely rather than racing the newer one.
    expect(writeOpens.maxConcurrent).toBe(1)
  })

  it('sweeps a usage temp file orphaned by a crash between write and rename', async () => {
    const orphan = join(tempUserData, 'orca-opencode-usage.json.999.1.abc.tmp')
    writeFileSync(orphan, '{}')

    createStoreWithState({})
    await vi.waitFor(() =>
      expect(readdirSync(tempUserData).filter((f) => f.endsWith('.tmp'))).toHaveLength(0)
    )
  })

  it('reports no data for Orca scope when only non-Orca OpenCode usage exists', async () => {
    const store = createStoreWithState({
      sessions: [
        makeSession({
          primaryProjectLabel: 'outside/repo',
          primaryWorktreeId: null,
          primaryRepoId: null
        })
      ],
      dailyAggregates: [
        makeDaily({
          projectKey: 'cwd:/outside/repo',
          projectLabel: 'outside/repo',
          repoId: null,
          worktreeId: null
        })
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.hasAnyOpenCodeData).toBe(false)
    expect(summary.sessions).toBe(0)
    expect(summary.events).toBe(0)
  })

  it('uses recorded OpenCode costs and token totals without model pricing inference', async () => {
    const store = createStoreWithState({
      sessions: [
        makeSession({ sessionId: 'session-1' }),
        makeSession({
          sessionId: 'session-2',
          primaryModel: 'openai/gpt-5.5',
          totalTokens: 2000,
          estimatedCostUsd: null,
          modelBreakdown: [
            {
              modelKey: 'openai/gpt-5.5',
              modelLabel: 'openai/gpt-5.5',
              eventCount: 1,
              inputTokens: 1500,
              cachedInputTokens: 200,
              outputTokens: 500,
              reasoningOutputTokens: 0,
              totalTokens: 2000,
              estimatedCostUsd: null
            }
          ]
        })
      ],
      dailyAggregates: [
        makeDaily(),
        makeDaily({
          model: 'openai/gpt-5.5',
          eventCount: 2,
          inputTokens: 1500,
          cachedInputTokens: 200,
          outputTokens: 500,
          reasoningOutputTokens: 0,
          totalTokens: 2000,
          estimatedCostUsd: null
        })
      ]
    })

    const summary = await store.getSummary('orca', '30d')
    const daily = await store.getDaily('orca', '30d')
    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(summary).toMatchObject({
      sessions: 2,
      events: 3,
      inputTokens: 2500,
      cachedInputTokens: 600,
      outputTokens: 750,
      reasoningOutputTokens: 100,
      totalTokens: 3350,
      estimatedCostUsd: 0.05,
      topModel: 'openai/gpt-5.5',
      topProject: 'Repo',
      hasAnyOpenCodeData: true
    })
    expect(daily).toEqual([
      {
        day: '2026-04-09',
        inputTokens: 2500,
        cachedInputTokens: 600,
        outputTokens: 750,
        reasoningOutputTokens: 100,
        totalTokens: 3350
      }
    ])
    expect(breakdown.find((row) => row.key === 'openai/gpt-5.5')).toMatchObject({
      sessions: 1,
      estimatedCostUsd: null
    })
  })

  it('returns recent sessions with OpenCode event and token fields', async () => {
    const store = createStoreWithState({
      sessions: [makeSession()],
      dailyAggregates: [makeDaily()]
    })

    const sessions = await store.getRecentSessions('orca', '30d', 5)

    expect(sessions).toEqual([
      {
        sessionId: 'session-1',
        lastActiveAt: '2026-04-09T10:10:00.000Z',
        durationMinutes: 10,
        projectLabel: 'Repo',
        model: 'anthropic/claude-sonnet-4-5',
        events: 1,
        inputTokens: 1000,
        cachedInputTokens: 400,
        outputTokens: 250,
        reasoningOutputTokens: 100,
        totalTokens: 1350
      }
    ])
  })

  it('normalizes persisted OpenCode state by schema version', () => {
    expect(
      normalizePersistedState({
        ...getDefaultState(),
        schemaVersion: 0,
        processedDatabases: [
          {
            path: '/tmp/opencode.db',
            mtimeMs: 1,
            size: 2,
            sessions: [makeSession()],
            dailyAggregates: [makeDaily()],
            ownedSessionIds: ['session-1'],
            hasDeferredClaims: false
          }
        ],
        sessions: [makeSession()],
        dailyAggregates: [makeDaily()]
      })
    ).toEqual(getDefaultState())

    expect(
      normalizePersistedState({
        ...getDefaultState(),
        processedDatabases: [
          {
            path: '/tmp/opencode.db',
            mtimeMs: 1,
            size: 2,
            sessions: [],
            dailyAggregates: [],
            ownedSessionIds: [],
            hasDeferredClaims: false
          }
        ]
      }).processedDatabases
    ).toHaveLength(1)
  })
})
