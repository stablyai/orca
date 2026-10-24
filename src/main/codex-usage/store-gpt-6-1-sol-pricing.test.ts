import { describe, expect, it, vi } from 'vitest'
import { createStoreWithState, setupCodexUsageStoreEnv } from './store-test-harness'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('../usage/usage-scan-worker-spawn', () => ({
  scanCodexUsageFilesViaWorker: vi.fn(),
  splitUsageCacheFileViaWorker: vi.fn()
}))

describe('CodexUsageStore GPT-6.1 Sol pricing', () => {
  setupCodexUsageStoreEnv(getPathMock)

  it.each(['orca', 'all'] as const)(
    'includes cached usage in %s summaries and breakdowns',
    async (scope) => {
      const store = createStoreWithState({
        dailyAggregates: ['gpt-6.1-sol', 'gpt-6.1-sol-high'].map((model) => ({
          day: '2026-04-09',
          model,
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 2,
          inputTokens: 2_300_000,
          cachedInputTokens: 1_150_000,
          outputTokens: 200_000,
          reasoningOutputTokens: 50_000,
          totalTokens: 2_500_000,
          hasInferredPricing: false,
          longContextInputTokens: 300_000,
          longContextCachedInputTokens: 150_000,
          longContextOutputTokens: 100_000
        }))
      })

      const summary = await store.getSummary(scope, '30d')
      const breakdown = await store.getBreakdown(scope, '30d', 'model')

      expect(summary.totalTokens).toBe(5_000_000)
      expect(summary.reasoningOutputTokens).toBe(100_000)
      expect(summary.estimatedCostUsd).toBeCloseTo(10.46, 9)
      expect(summary.hasUnpricedModels).toBe(false)
      expect(breakdown).toHaveLength(2)
      for (const row of breakdown) {
        expect(row.estimatedCostUsd).toBeCloseTo(5.23, 9)
      }
    }
  )
})
