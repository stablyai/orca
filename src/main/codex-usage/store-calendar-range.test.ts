import { describe, expect, it, vi } from 'vitest'
import { createStoreWithState, setupCodexUsageStoreEnv } from './store-test-harness'

const { getPathMock } = vi.hoisted(() => ({ getPathMock: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('../usage/usage-scan-worker-spawn', () => ({
  scanCodexUsageFilesViaWorker: vi.fn(),
  splitUsageCacheFileViaWorker: vi.fn()
}))

describe('Codex calendar-range snapshots', () => {
  setupCodexUsageStoreEnv(getPathMock)

  it('excludes yesterday from today tokens, cost, breakdown and pricing warnings', async () => {
    vi.setSystemTime(new Date(2026, 3, 10, 12))
    const tokens = {
      projectKey: 'worktree:repo::/workspace',
      projectLabel: 'Repo',
      repoId: 'repo',
      worktreeId: 'repo::/workspace',
      eventCount: 1,
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 250,
      reasoningOutputTokens: 100,
      totalTokens: 1250,
      hasInferredPricing: false,
      longContextInputTokens: 0,
      longContextCachedInputTokens: 0,
      longContextOutputTokens: 0
    }
    const store = createStoreWithState({
      dailyAggregates: [
        { ...tokens, day: '2026-04-09', model: 'unpriced-test-model' },
        { ...tokens, day: '2026-04-10', model: 'gpt-5' }
      ]
    })
    const today = store.getSnapshot('orca', 'today')
    const week = store.getSnapshot('orca', '7d')

    expect(today.summary.totalTokens).toBe(1250)
    expect(week.summary.totalTokens).toBe(2500)
    expect(today.summary.estimatedCostUsd).toBeGreaterThan(0)
    expect(today.summary.hasUnpricedModels).toBe(false)
    expect(week.summary.hasUnpricedModels).toBe(true)
    expect(today.daily).toHaveLength(1)
    expect(today.daily[0]?.day).toBe('2026-04-10')
    expect(today.modelBreakdown.map((row) => row.key)).toEqual(['gpt-5'])
  })
})
