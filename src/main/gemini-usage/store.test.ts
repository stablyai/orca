import { describe, expect, it, vi } from 'vitest'
import { GeminiUsageStore, normalizePersistedState } from './store'
import type { GeminiUsagePersistedState } from './types'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-gemini-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('./scanner', () => ({
  scanGeminiUsageFiles: vi.fn().mockResolvedValue({
    processedFiles: [],
    sessions: [],
    dailyAggregates: []
  })
}))

describe('GeminiUsageStore', () => {
  const mockStore = {
    getRepos: () => [],
    getAllWorktreeMeta: () => ({})
  }

  function createTestStoreWithState(initialState: Partial<GeminiUsagePersistedState>) {
    const store = new GeminiUsageStore(mockStore)
    // @ts-expect-error -- test access to protected state
    store.state = {
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
      },
      ...initialState
    }
    return store
  }

  it('builds summary with cost estimation and breakdown', async () => {
    const store = createTestStoreWithState({
      dailyAggregates: [
        {
          day: '2026-05-10',
          model: 'gemini-2.5-pro',
          projectKey: 'worktree:wt-1',
          projectLabel: 'my-project',
          repoId: 'repo-1',
          worktreeId: 'wt-1',
          eventCount: 3,
          inputTokens: 10_000,
          cachedInputTokens: 2_000,
          outputTokens: 1_000,
          reasoningOutputTokens: 200,
          totalTokens: 11_000,
          hasInferredPricing: false,
          estimatedCostUsd: 0.02
        }
      ],
      sessions: [
        {
          sessionId: 'session-1',
          firstTimestamp: '2026-05-10T10:00:00.000Z',
          lastTimestamp: '2026-05-10T10:30:00.000Z',
          primaryModel: 'gemini-2.5-pro',
          hasMixedModels: false,
          primaryProjectLabel: 'my-project',
          hasMixedLocations: false,
          primaryWorktreeId: 'wt-1',
          primaryRepoId: 'repo-1',
          eventCount: 3,
          totalInputTokens: 10_000,
          totalCachedInputTokens: 2_000,
          totalOutputTokens: 1_000,
          totalReasoningOutputTokens: 200,
          totalTokens: 11_000,
          hasInferredPricing: false,
          estimatedCostUsd: 0.02,
          locationBreakdown: [
            {
              locationKey: 'worktree:wt-1',
              projectLabel: 'my-project',
              repoId: 'repo-1',
              worktreeId: 'wt-1',
              eventCount: 3,
              inputTokens: 10_000,
              cachedInputTokens: 2_000,
              outputTokens: 1_000,
              reasoningOutputTokens: 200,
              totalTokens: 11_000,
              hasInferredPricing: false,
              estimatedCostUsd: 0.02
            }
          ],
          modelBreakdown: [
            {
              modelKey: 'gemini-2.5-pro',
              modelLabel: 'gemini-2.5-pro',
              hasInferredPricing: false,
              estimatedCostUsd: 0.02,
              eventCount: 3,
              inputTokens: 10_000,
              cachedInputTokens: 2_000,
              outputTokens: 1_000,
              reasoningOutputTokens: 200,
              totalTokens: 11_000
            }
          ],
          locationModelBreakdown: []
        }
      ]
    })

    const summary = await store.getSummary('orca', 'all')
    expect(summary.sessions).toBe(1)
    expect(summary.events).toBe(3)
    expect(summary.inputTokens).toBe(10_000)
    expect(summary.cachedInputTokens).toBe(2_000)
    expect(summary.outputTokens).toBe(1_000)
    expect(summary.totalTokens).toBe(11_000)
    expect(summary.topModel).toBe('gemini-2.5-pro')
    expect(summary.topProject).toBe('my-project')
    expect(summary.estimatedCostUsd).toBeDefined()
    expect(summary.estimatedCostUsd).toBeGreaterThan(0)
    const daily = await store.getDaily('orca', 'all')
    expect(daily).toHaveLength(1)
    expect(daily[0]?.day).toBe('2026-05-10')
    expect(daily[0]?.totalTokens).toBe(11_000)
    const modelBreakdown = await store.getBreakdown('orca', 'all', 'model')
    expect(modelBreakdown).toHaveLength(1)
    expect(modelBreakdown[0]?.key).toBe('gemini-2.5-pro')
    const projectBreakdown = await store.getBreakdown('orca', 'all', 'project')
    expect(projectBreakdown).toHaveLength(1)
    expect(projectBreakdown[0]?.key).toBe('worktree:wt-1')

    const recentSessions = await store.getRecentSessions('orca', 'all')
    expect(recentSessions).toHaveLength(1)
    expect(recentSessions[0]?.sessionId).toBe('session-1')
    expect(recentSessions[0]?.durationMinutes).toBe(30)
  })

  it('filters by scope correctly between orca and all', async () => {
    const store = createTestStoreWithState({
      dailyAggregates: [
        {
          day: '2026-05-10',
          model: 'gemini-2.5-flash',
          projectKey: 'path:/outside',
          projectLabel: 'outside',
          repoId: null,
          worktreeId: null,
          eventCount: 1,
          inputTokens: 500,
          cachedInputTokens: 0,
          outputTokens: 100,
          reasoningOutputTokens: 0,
          totalTokens: 600,
          hasInferredPricing: false,
          estimatedCostUsd: 0.0001
        }
      ],
      sessions: [
        {
          sessionId: 'outside-session',
          firstTimestamp: '2026-05-10T10:00:00.000Z',
          lastTimestamp: '2026-05-10T10:05:00.000Z',
          primaryModel: 'gemini-2.5-flash',
          hasMixedModels: false,
          primaryProjectLabel: 'outside',
          hasMixedLocations: false,
          primaryWorktreeId: null,
          primaryRepoId: null,
          eventCount: 1,
          totalInputTokens: 500,
          totalCachedInputTokens: 0,
          totalOutputTokens: 100,
          totalReasoningOutputTokens: 0,
          totalTokens: 600,
          hasInferredPricing: false,
          estimatedCostUsd: 0.0001,
          locationBreakdown: [
            {
              locationKey: 'path:/outside',
              projectLabel: 'outside',
              repoId: null,
              worktreeId: null,
              eventCount: 1,
              inputTokens: 500,
              cachedInputTokens: 0,
              outputTokens: 100,
              reasoningOutputTokens: 0,
              totalTokens: 600,
              hasInferredPricing: false,
              estimatedCostUsd: 0.0001
            }
          ],
          modelBreakdown: [],
          locationModelBreakdown: []
        }
      ]
    })

    const orcaSummary = await store.getSummary('orca', 'all')
    expect(orcaSummary.sessions).toBe(0)
    expect(orcaSummary.events).toBe(0)

    const allSummary = await store.getSummary('all', 'all')
    expect(allSummary.sessions).toBe(1)
    expect(allSummary.events).toBe(1)
    expect(allSummary.totalTokens).toBe(600)
  })

  it('normalizes outdated schema versions by resetting projections while keeping enabled state', () => {
    const outdated: GeminiUsagePersistedState = {
      schemaVersion: 0,
      worktreeFingerprint: 'abc',
      processedFiles: [],
      sessions: [{} as never],
      dailyAggregates: [{} as never],
      scanState: {
        enabled: true,
        lastScanStartedAt: 10,
        lastScanCompletedAt: 20,
        lastScanError: null
      }
    }

    const normalized = normalizePersistedState(outdated)
    expect(normalized.schemaVersion).toBe(1)
    expect(normalized.sessions).toEqual([])
    expect(normalized.dailyAggregates).toEqual([])
    expect(normalized.scanState.enabled).toBe(true)
  })
})
