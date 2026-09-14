import { describe, expect, it, vi } from 'vitest'
import { createStoreWithState, setupCodexUsageStoreEnv } from './store-test-harness'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('./scanner', () => ({
  scanCodexUsageFiles: vi.fn()
}))

describe('CodexUsageStore', () => {
  setupCodexUsageStoreEnv(getPathMock)

  it('calculates cost from uncached input plus cached input without double billing', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'gpt-5',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 2,
          inputTokens: 1000,
          cachedInputTokens: 400,
          outputTokens: 250,
          reasoningOutputTokens: 100,
          totalTokens: 1250,
          hasInferredPricing: false
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.estimatedCostUsd).toBeCloseTo(0.0014)
    expect(summary.totalTokens).toBe(1250)
    expect(summary.reasoningOutputTokens).toBe(100)
  })

  it('prices current Codex models with current model rates', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'gpt-5.2-codex',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 2_000_000,
          cachedInputTokens: 1_000_000,
          outputTokens: 1_000_000,
          reasoningOutputTokens: 100_000,
          totalTokens: 3_000_000,
          hasInferredPricing: false
        },
        {
          day: '2026-04-09',
          model: 'gpt-5.3-codex',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 2_000_000,
          cachedInputTokens: 1_000_000,
          outputTokens: 1_000_000,
          reasoningOutputTokens: 100_000,
          totalTokens: 3_000_000,
          hasInferredPricing: false
        },
        {
          day: '2026-04-09',
          model: 'gpt-5.4',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 2_000_000,
          cachedInputTokens: 1_000_000,
          outputTokens: 1_000_000,
          reasoningOutputTokens: 100_000,
          totalTokens: 3_000_000,
          hasInferredPricing: false
        },
        {
          day: '2026-04-09',
          model: 'gpt-5.5',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 2_000_000,
          cachedInputTokens: 1_000_000,
          outputTokens: 1_000_000,
          reasoningOutputTokens: 100_000,
          totalTokens: 3_000_000,
          hasInferredPricing: false
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')
    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(summary.estimatedCostUsd).toBeCloseTo(107.486)
    expect(breakdown.find((row) => row.key === 'gpt-5.2-codex')?.estimatedCostUsd).toBeCloseTo(
      15.925
    )
    expect(breakdown.find((row) => row.key === 'gpt-5.3-codex')?.estimatedCostUsd).toBeCloseTo(
      15.925
    )
    expect(breakdown.find((row) => row.key === 'gpt-5.4')?.estimatedCostUsd).toBeCloseTo(25.212)
    expect(breakdown.find((row) => row.key === 'gpt-5.5')?.estimatedCostUsd).toBeCloseTo(50.424)
  })

  it('prices GPT-5.6 sol, terra, and luna with current OpenAI rates', async () => {
    const store = createStoreWithState({
      dailyAggregates: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'].map((model) => ({
        day: '2026-04-09',
        model,
        projectKey: 'worktree:repo-1::/workspace/repo',
        projectLabel: 'Repo',
        repoId: 'repo-1',
        worktreeId: 'repo-1::/workspace/repo',
        eventCount: 1,
        inputTokens: 2_000_000,
        cachedInputTokens: 1_000_000,
        outputTokens: 1_000_000,
        reasoningOutputTokens: 100_000,
        totalTokens: 3_000_000,
        hasInferredPricing: false
      }))
    })

    const summary = await store.getSummary('orca', '30d')
    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(summary.estimatedCostUsd).toBeCloseTo(85.7208)
    expect(breakdown.find((row) => row.key === 'gpt-5.6-sol')?.estimatedCostUsd).toBeCloseTo(50.424)
    expect(breakdown.find((row) => row.key === 'gpt-5.6-terra')?.estimatedCostUsd).toBeCloseTo(
      25.212
    )
    expect(breakdown.find((row) => row.key === 'gpt-5.6-luna')?.estimatedCostUsd).toBeCloseTo(
      10.0848
    )
  })

  it('normalizes GPT-5.6 reasoning suffixes before pricing', async () => {
    const store = createStoreWithState({
      dailyAggregates: ['gpt-5.6-terra-high', 'gpt-5.6-luna(medium)'].map((model) => ({
        day: '2026-04-09',
        model,
        projectKey: 'worktree:repo-1::/workspace/repo',
        projectLabel: 'Repo',
        repoId: 'repo-1',
        worktreeId: 'repo-1::/workspace/repo',
        eventCount: 1,
        inputTokens: 100_000,
        cachedInputTokens: 50_000,
        outputTokens: 25_000,
        reasoningOutputTokens: 5_000,
        totalTokens: 125_000,
        hasInferredPricing: false
      }))
    })

    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(breakdown.find((row) => row.key === 'gpt-5.6-terra-high')?.estimatedCostUsd).toBeCloseTo(
      0.5125
    )
    expect(
      breakdown.find((row) => row.key === 'gpt-5.6-luna(medium)')?.estimatedCostUsd
    ).toBeCloseTo(0.205)
  })

  it('prices the bare gpt-5.6 alias at Sol rates without shadowing the tier IDs', async () => {
    const store = createStoreWithState({
      dailyAggregates: ['gpt-5.6', 'gpt-5.6-luna'].map((model) => ({
        day: '2026-04-09',
        model,
        projectKey: 'worktree:repo-1::/workspace/repo',
        projectLabel: 'Repo',
        repoId: 'repo-1',
        worktreeId: 'repo-1::/workspace/repo',
        eventCount: 1,
        inputTokens: 100_000,
        cachedInputTokens: 50_000,
        outputTokens: 25_000,
        reasoningOutputTokens: 5_000,
        totalTokens: 125_000,
        hasInferredPricing: false
      }))
    })

    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(breakdown.find((row) => row.key === 'gpt-5.6')?.estimatedCostUsd).toBeCloseTo(1.025)
    expect(breakdown.find((row) => row.key === 'gpt-5.6-luna')?.estimatedCostUsd).toBeCloseTo(0.205)
  })

  it('normalizes Codex model variants and reasoning suffixes before pricing', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'gpt-5.4-mini-high',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 1_000_000,
          cachedInputTokens: 500_000,
          outputTokens: 1_000_000,
          reasoningOutputTokens: 100_000,
          totalTokens: 2_000_000,
          hasInferredPricing: false
        },
        {
          day: '2026-04-09',
          model: 'gpt-5.3-codex-spark-xhigh',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 2_000_000,
          cachedInputTokens: 1_000_000,
          outputTokens: 1_000_000,
          reasoningOutputTokens: 100_000,
          totalTokens: 3_000_000,
          hasInferredPricing: false
        },
        {
          day: '2026-04-09',
          model: 'gpt-5.5(xhigh)',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 100_000,
          cachedInputTokens: 50_000,
          outputTokens: 25_000,
          reasoningOutputTokens: 5_000,
          totalTokens: 125_000,
          hasInferredPricing: false
        }
      ]
    })

    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(breakdown.find((row) => row.key === 'gpt-5.4-mini-high')?.estimatedCostUsd).toBeCloseTo(
      4.9125
    )
    expect(
      breakdown.find((row) => row.key === 'gpt-5.3-codex-spark-xhigh')?.estimatedCostUsd
    ).toBeCloseTo(15.925)
    expect(breakdown.find((row) => row.key === 'gpt-5.5(xhigh)')?.estimatedCostUsd).toBeCloseTo(
      1.025
    )
  })

  it('keeps cached input out of the full-price input bucket for GPT-5.5 totals', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'gpt-5.5',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 491_053_514,
          cachedInputTokens: 459_283_584,
          outputTokens: 1_944_952,
          reasoningOutputTokens: 551_764,
          totalTokens: 492_998_466,
          hasInferredPricing: false
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.estimatedCostUsd).toBeCloseTo(858.929724)
  })
})
