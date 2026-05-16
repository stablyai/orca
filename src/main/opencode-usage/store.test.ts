import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  OpenCodeUsageDailyAggregate,
  OpenCodeUsagePersistedState,
  OpenCodeUsageSession
} from './types'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { OpenCodeUsageStore, normalizePersistedState } from './store'

function getDefaultState(): OpenCodeUsagePersistedState {
  return {
    schemaVersion: 1,
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
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-10T12:00:00.000-04:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
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
        processedDatabases: [
          {
            path: '/tmp/opencode.db',
            mtimeMs: 1,
            size: 2,
            sessions: [],
            dailyAggregates: []
          }
        ]
      }).processedDatabases
    ).toHaveLength(1)
  })
})
