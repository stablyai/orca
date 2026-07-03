import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KimiUsageDailyAggregate, KimiUsagePersistedState, KimiUsageSession } from './types'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { KimiUsageStore, normalizePersistedState } from './store'

function getDefaultState(): KimiUsagePersistedState {
  return {
    schemaVersion: 1,
    worktreeFingerprint: null,
    processedFiles: [],
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

function createStoreWithState(state: Partial<KimiUsagePersistedState>): KimiUsageStore {
  const store = new KimiUsageStore({
    getRepos: () => [],
    getWorktreeMeta: () => undefined
  } as never)

  ;(store as unknown as { state: KimiUsagePersistedState }).state = {
    ...getDefaultState(),
    ...state
  }

  return store
}

// Kimi records no cost: estimatedCostUsd is null on every projection level.
function makeSession(overrides: Partial<KimiUsageSession> = {}): KimiUsageSession {
  const worktreeId = overrides.primaryWorktreeId ?? 'repo-1::/workspace/repo'
  const repoId = overrides.primaryRepoId ?? 'repo-1'
  const projectLabel = overrides.primaryProjectLabel ?? 'Repo'
  const model = overrides.primaryModel ?? 'kimi-k2'
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
    totalReasoningOutputTokens: 0,
    totalTokens: 1650,
    estimatedCostUsd: null,
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
        reasoningOutputTokens: 0,
        totalTokens: 1650,
        estimatedCostUsd: null
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
        reasoningOutputTokens: 0,
        totalTokens: 1650,
        estimatedCostUsd: null
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
        reasoningOutputTokens: 0,
        totalTokens: 1650,
        estimatedCostUsd: null
      }
    ],
    ...overrides
  }
}

function makeDaily(overrides: Partial<KimiUsageDailyAggregate> = {}): KimiUsageDailyAggregate {
  const worktreeId = overrides.worktreeId ?? 'repo-1::/workspace/repo'
  return {
    day: '2026-04-09',
    model: 'kimi-k2',
    projectKey: worktreeId ? `worktree:${worktreeId}` : 'cwd:/outside/repo',
    projectLabel: worktreeId ? 'Repo' : 'outside/repo',
    repoId: worktreeId ? 'repo-1' : null,
    worktreeId,
    eventCount: 1,
    inputTokens: 1000,
    cachedInputTokens: 400,
    outputTokens: 250,
    reasoningOutputTokens: 0,
    totalTokens: 1650,
    estimatedCostUsd: null,
    ...overrides
  }
}

describe('KimiUsageStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-10T12:00:00.000-04:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports no data for Orca scope when only non-Orca Kimi usage exists', async () => {
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

    expect(summary.hasAnyKimiData).toBe(false)
    expect(summary.sessions).toBe(0)
    expect(summary.events).toBe(0)
  })

  it('filters out usage older than the selected range', async () => {
    const store = createStoreWithState({
      sessions: [makeSession()],
      dailyAggregates: [makeDaily()]
    })

    // The single day is 2026-04-09; a 7-day window anchored at 2026-04-10 includes it.
    const within = await store.getSummary('orca', '7d')
    expect(within.totalTokens).toBe(1650)

    // Push the system clock far ahead so the same day falls outside a 7-day window.
    vi.setSystemTime(new Date('2026-05-30T12:00:00.000-04:00'))
    const outside = await store.getSummary('orca', '7d')
    expect(outside.totalTokens).toBe(0)
    expect(outside.hasAnyKimiData).toBe(false)
  })

  it('builds summary, daily, and breakdown projections with null cost', async () => {
    const store = createStoreWithState({
      sessions: [
        makeSession({ sessionId: 'session-1' }),
        makeSession({
          sessionId: 'session-2',
          primaryModel: 'kimi-k2-turbo',
          totalTokens: 2000,
          modelBreakdown: [
            {
              modelKey: 'kimi-k2-turbo',
              modelLabel: 'kimi-k2-turbo',
              eventCount: 1,
              inputTokens: 1500,
              cachedInputTokens: 200,
              outputTokens: 300,
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
          model: 'kimi-k2-turbo',
          eventCount: 2,
          inputTokens: 1500,
          cachedInputTokens: 200,
          outputTokens: 300,
          reasoningOutputTokens: 0,
          totalTokens: 2000
        })
      ]
    })

    const summary = await store.getSummary('orca', '30d')
    const daily = await store.getDaily('orca', '30d')
    const modelBreakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(summary).toMatchObject({
      sessions: 2,
      events: 3,
      inputTokens: 2500,
      cachedInputTokens: 600,
      outputTokens: 550,
      reasoningOutputTokens: 0,
      totalTokens: 3650,
      estimatedCostUsd: null,
      topModel: 'kimi-k2-turbo',
      topProject: 'Repo',
      hasAnyKimiData: true
    })
    expect(daily).toEqual([
      {
        day: '2026-04-09',
        inputTokens: 2500,
        cachedInputTokens: 600,
        outputTokens: 550,
        reasoningOutputTokens: 0,
        totalTokens: 3650
      }
    ])
    expect(modelBreakdown.find((row) => row.key === 'kimi-k2-turbo')).toMatchObject({
      sessions: 1,
      estimatedCostUsd: null
    })
  })

  it('returns recent sessions with Kimi event and token fields', async () => {
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
        model: 'kimi-k2',
        events: 1,
        inputTokens: 1000,
        cachedInputTokens: 400,
        outputTokens: 250,
        reasoningOutputTokens: 0,
        totalTokens: 1650
      }
    ])
  })

  it('normalizes persisted Kimi state by schema version', () => {
    expect(
      normalizePersistedState({
        ...getDefaultState(),
        schemaVersion: 0,
        processedFiles: [
          {
            path: '/tmp/wire.jsonl',
            mtimeMs: 1,
            size: 2,
            sessions: [makeSession()],
            dailyAggregates: [makeDaily()]
          }
        ],
        sessions: [makeSession()],
        dailyAggregates: [makeDaily()]
      })
    ).toEqual(getDefaultState())

    expect(
      normalizePersistedState({
        ...getDefaultState(),
        processedFiles: [
          {
            path: '/tmp/wire.jsonl',
            mtimeMs: 1,
            size: 2,
            sessions: [],
            dailyAggregates: []
          }
        ]
      }).processedFiles
    ).toHaveLength(1)
  })
})
