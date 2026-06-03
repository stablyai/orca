import { performance } from 'node:perf_hooks'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexUsagePersistedState } from './types'
import { CodexUsageStore } from './store'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

function createStoreWithState(state: CodexUsagePersistedState): CodexUsageStore {
  const store = new CodexUsageStore({
    getRepos: () => [],
    getWorktreeMeta: () => undefined
  } as never)

  ;(store as unknown as { state: CodexUsagePersistedState }).state = state
  return store
}

function createLargeState(): CodexUsagePersistedState {
  const dailyAggregates = Array.from({ length: 12_000 }, (_, index) => ({
    day: `2026-04-${String((index % 30) + 1).padStart(2, '0')}`,
    model: index % 2 === 0 ? 'gpt-5' : 'gpt-5.1-codex',
    projectKey: `worktree:wt-${index % 400}`,
    projectLabel: `Worktree ${index % 400}`,
    repoId: `repo-${index % 40}`,
    worktreeId: `wt-${index % 400}`,
    eventCount: 3,
    inputTokens: 1_000,
    cachedInputTokens: 250,
    outputTokens: 500,
    reasoningOutputTokens: 50,
    totalTokens: 1_500,
    hasInferredPricing: false
  }))
  const sessions = Array.from({ length: 8_000 }, (_, index) => ({
    sessionId: `session-${index}`,
    firstTimestamp: `2026-04-${String((index % 30) + 1).padStart(2, '0')}T10:00:00.000Z`,
    lastTimestamp: `2026-04-${String((index % 30) + 1).padStart(2, '0')}T10:10:00.000Z`,
    primaryModel: 'gpt-5',
    hasMixedModels: false,
    primaryProjectLabel: `Worktree ${index % 400}`,
    hasMixedLocations: false,
    primaryWorktreeId: `wt-${index % 400}`,
    primaryRepoId: `repo-${index % 40}`,
    eventCount: 3,
    totalInputTokens: 1_000,
    totalCachedInputTokens: 250,
    totalOutputTokens: 500,
    totalReasoningOutputTokens: 50,
    totalTokens: 1_500,
    hasInferredPricing: false,
    locationBreakdown: [
      {
        locationKey: `worktree:wt-${index % 400}`,
        projectLabel: `Worktree ${index % 400}`,
        repoId: `repo-${index % 40}`,
        worktreeId: `wt-${index % 400}`,
        eventCount: 3,
        inputTokens: 1_000,
        cachedInputTokens: 250,
        outputTokens: 500,
        reasoningOutputTokens: 50,
        totalTokens: 1_500,
        hasInferredPricing: false
      }
    ],
    modelBreakdown: [
      {
        modelKey: 'gpt-5',
        modelLabel: 'gpt-5',
        hasInferredPricing: false,
        eventCount: 3,
        inputTokens: 1_000,
        cachedInputTokens: 250,
        outputTokens: 500,
        reasoningOutputTokens: 50,
        totalTokens: 1_500
      }
    ],
    locationModelBreakdown: [
      {
        locationKey: `worktree:wt-${index % 400}`,
        modelKey: 'gpt-5',
        modelLabel: 'gpt-5',
        repoId: `repo-${index % 40}`,
        worktreeId: `wt-${index % 400}`,
        eventCount: 3,
        inputTokens: 1_000,
        cachedInputTokens: 250,
        outputTokens: 500,
        reasoningOutputTokens: 50,
        totalTokens: 1_500,
        hasInferredPricing: false
      }
    ]
  }))

  return {
    schemaVersion: 3,
    worktreeFingerprint: 'stable',
    processedFiles: [],
    sessions,
    dailyAggregates,
    scanState: {
      enabled: true,
      lastScanStartedAt: 1,
      lastScanCompletedAt: 2,
      lastScanError: null
    }
  }
}

describe('CodexUsageStore snapshot benchmark', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-30T12:00:00.000Z'))
  })

  it('builds a cached dashboard snapshot without waiting for refresh', () => {
    const store = createStoreWithState(createLargeState())
    const startedAt = performance.now()

    const snapshot = store.getSnapshot('orca', '30d', 10)

    const snapshotMs = performance.now() - startedAt
    expect(snapshot.summary.totalTokens).toBe(18_000_000)
    expect(snapshot.recentSessions).toHaveLength(10)
    // Why: full-suite CI runs this beside thousands of tests on shared runners.
    // Keep a coarse guard so this catches accidental scan-like work without
    // treating runner contention as a product regression.
    expect(snapshotMs).toBeLessThan(1_000)
  })
})
