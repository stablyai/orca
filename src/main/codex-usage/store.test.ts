/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexUsagePersistedState } from './types'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

import { CodexUsageStore, normalizePersistedState } from './store'

function createStoreWithState(state: Partial<CodexUsagePersistedState>): CodexUsageStore {
  const store = new CodexUsageStore({
    getRepos: () => [],
    getWorktreeMeta: () => undefined
  } as never)

  ;(store as unknown as { state: CodexUsagePersistedState }).state = {
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
    ...state
  }

  return store
}

describe('CodexUsageStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-10T12:00:00.000-04:00'))
  })

  it('reports no data for Orca scope when only non-Orca Codex usage exists', async () => {
    const store = createStoreWithState({
      sessions: [
        {
          sessionId: 'session-1',
          firstTimestamp: '2026-04-09T10:00:00.000Z',
          lastTimestamp: '2026-04-09T10:10:00.000Z',
          primaryModel: 'gpt-5',
          hasMixedModels: false,
          primaryProjectLabel: 'outside/repo',
          hasMixedLocations: false,
          primaryWorktreeId: null,
          primaryRepoId: null,
          eventCount: 1,
          totalInputTokens: 1000,
          totalCachedInputTokens: 400,
          totalOutputTokens: 250,
          totalReasoningOutputTokens: 100,
          totalTokens: 1250,
          hasInferredPricing: false,
          locationBreakdown: [
            {
              locationKey: 'cwd:/outside/repo',
              projectLabel: 'outside/repo',
              repoId: null,
              worktreeId: null,
              eventCount: 1,
              inputTokens: 1000,
              cachedInputTokens: 400,
              outputTokens: 250,
              reasoningOutputTokens: 100,
              totalTokens: 1250,
              hasInferredPricing: false
            }
          ],
          modelBreakdown: [
            {
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              eventCount: 1,
              inputTokens: 1000,
              cachedInputTokens: 400,
              outputTokens: 250,
              reasoningOutputTokens: 100,
              totalTokens: 1250,
              hasInferredPricing: false
            }
          ],
          locationModelBreakdown: [
            {
              locationKey: 'cwd:/outside/repo',
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              repoId: null,
              worktreeId: null,
              eventCount: 1,
              inputTokens: 1000,
              cachedInputTokens: 400,
              outputTokens: 250,
              reasoningOutputTokens: 100,
              totalTokens: 1250,
              hasInferredPricing: false
            }
          ]
        }
      ],
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'gpt-5',
          projectKey: 'cwd:/outside/repo',
          projectLabel: 'outside/repo',
          repoId: null,
          worktreeId: null,
          eventCount: 1,
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

    expect(summary.hasAnyCodexData).toBe(false)
    expect(summary.sessions).toBe(0)
    expect(summary.events).toBe(0)
  })

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

    expect(summary.estimatedCostUsd).toBeCloseTo(85.1)
    expect(breakdown.find((row) => row.key === 'gpt-5.2-codex')?.estimatedCostUsd).toBeCloseTo(
      15.925
    )
    expect(breakdown.find((row) => row.key === 'gpt-5.3-codex')?.estimatedCostUsd).toBeCloseTo(
      15.925
    )
    expect(breakdown.find((row) => row.key === 'gpt-5.4')?.estimatedCostUsd).toBeCloseTo(17.75)
    expect(breakdown.find((row) => row.key === 'gpt-5.5')?.estimatedCostUsd).toBeCloseTo(35.5)
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

    expect(summary.estimatedCostUsd).toBeCloseTo(446.840002)
  })

  it('counts mixed-model sessions once for each real model row in the breakdown', async () => {
    const store = createStoreWithState({
      sessions: [
        {
          sessionId: 'session-1',
          firstTimestamp: '2026-04-09T10:00:00.000Z',
          lastTimestamp: '2026-04-09T10:10:00.000Z',
          primaryModel: 'Mixed models',
          hasMixedModels: true,
          primaryProjectLabel: 'Repo',
          hasMixedLocations: false,
          primaryWorktreeId: 'repo-1::/workspace/repo',
          primaryRepoId: 'repo-1',
          eventCount: 2,
          totalInputTokens: 300,
          totalCachedInputTokens: 100,
          totalOutputTokens: 90,
          totalReasoningOutputTokens: 10,
          totalTokens: 390,
          hasInferredPricing: false,
          locationBreakdown: [
            {
              locationKey: 'worktree:repo-1::/workspace/repo',
              projectLabel: 'Repo',
              repoId: 'repo-1',
              worktreeId: 'repo-1::/workspace/repo',
              eventCount: 2,
              inputTokens: 300,
              cachedInputTokens: 100,
              outputTokens: 90,
              reasoningOutputTokens: 10,
              totalTokens: 390,
              hasInferredPricing: false
            }
          ],
          modelBreakdown: [
            {
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              eventCount: 1,
              inputTokens: 100,
              cachedInputTokens: 20,
              outputTokens: 30,
              reasoningOutputTokens: 5,
              totalTokens: 130,
              hasInferredPricing: false
            },
            {
              modelKey: 'gpt-5.2-codex',
              modelLabel: 'gpt-5.2-codex',
              eventCount: 1,
              inputTokens: 200,
              cachedInputTokens: 80,
              outputTokens: 60,
              reasoningOutputTokens: 5,
              totalTokens: 260,
              hasInferredPricing: false
            }
          ],
          locationModelBreakdown: [
            {
              locationKey: 'worktree:repo-1::/workspace/repo',
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              repoId: 'repo-1',
              worktreeId: 'repo-1::/workspace/repo',
              eventCount: 1,
              inputTokens: 100,
              cachedInputTokens: 20,
              outputTokens: 30,
              reasoningOutputTokens: 5,
              totalTokens: 130,
              hasInferredPricing: false
            },
            {
              locationKey: 'worktree:repo-1::/workspace/repo',
              modelKey: 'gpt-5.2-codex',
              modelLabel: 'gpt-5.2-codex',
              repoId: 'repo-1',
              worktreeId: 'repo-1::/workspace/repo',
              eventCount: 1,
              inputTokens: 200,
              cachedInputTokens: 80,
              outputTokens: 60,
              reasoningOutputTokens: 5,
              totalTokens: 260,
              hasInferredPricing: false
            }
          ]
        }
      ],
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'gpt-5',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 5,
          totalTokens: 130,
          hasInferredPricing: false
        },
        {
          day: '2026-04-09',
          model: 'gpt-5.2-codex',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 200,
          cachedInputTokens: 80,
          outputTokens: 60,
          reasoningOutputTokens: 5,
          totalTokens: 260,
          hasInferredPricing: false
        }
      ]
    })

    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(breakdown.find((row) => row.key === 'gpt-5')?.sessions).toBe(1)
    expect(breakdown.find((row) => row.key === 'gpt-5.2-codex')?.sessions).toBe(1)
  })

  it('uses only Orca-scoped models when projecting mixed-scope sessions', async () => {
    const store = createStoreWithState({
      sessions: [
        {
          sessionId: 'session-1',
          firstTimestamp: '2026-04-09T10:00:00.000Z',
          lastTimestamp: '2026-04-09T10:10:00.000Z',
          primaryModel: 'Mixed models',
          hasMixedModels: true,
          primaryProjectLabel: 'Multiple locations',
          hasMixedLocations: true,
          primaryWorktreeId: 'repo-1::/workspace/repo',
          primaryRepoId: 'repo-1',
          eventCount: 2,
          totalInputTokens: 300,
          totalCachedInputTokens: 60,
          totalOutputTokens: 90,
          totalReasoningOutputTokens: 10,
          totalTokens: 390,
          hasInferredPricing: false,
          locationBreakdown: [
            {
              locationKey: 'worktree:repo-1::/workspace/repo',
              projectLabel: 'Repo',
              repoId: 'repo-1',
              worktreeId: 'repo-1::/workspace/repo',
              eventCount: 1,
              inputTokens: 100,
              cachedInputTokens: 20,
              outputTokens: 30,
              reasoningOutputTokens: 5,
              totalTokens: 130,
              hasInferredPricing: false
            },
            {
              locationKey: 'cwd:/outside/repo',
              projectLabel: 'outside/repo',
              repoId: null,
              worktreeId: null,
              eventCount: 1,
              inputTokens: 200,
              cachedInputTokens: 40,
              outputTokens: 60,
              reasoningOutputTokens: 5,
              totalTokens: 260,
              hasInferredPricing: false
            }
          ],
          modelBreakdown: [
            {
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              eventCount: 1,
              inputTokens: 100,
              cachedInputTokens: 20,
              outputTokens: 30,
              reasoningOutputTokens: 5,
              totalTokens: 130,
              hasInferredPricing: false
            },
            {
              modelKey: 'gpt-5.2-codex',
              modelLabel: 'gpt-5.2-codex',
              eventCount: 1,
              inputTokens: 200,
              cachedInputTokens: 40,
              outputTokens: 60,
              reasoningOutputTokens: 5,
              totalTokens: 260,
              hasInferredPricing: false
            }
          ],
          locationModelBreakdown: [
            {
              locationKey: 'worktree:repo-1::/workspace/repo',
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              repoId: 'repo-1',
              worktreeId: 'repo-1::/workspace/repo',
              eventCount: 1,
              inputTokens: 100,
              cachedInputTokens: 20,
              outputTokens: 30,
              reasoningOutputTokens: 5,
              totalTokens: 130,
              hasInferredPricing: false
            },
            {
              locationKey: 'cwd:/outside/repo',
              modelKey: 'gpt-5.2-codex',
              modelLabel: 'gpt-5.2-codex',
              repoId: null,
              worktreeId: null,
              eventCount: 1,
              inputTokens: 200,
              cachedInputTokens: 40,
              outputTokens: 60,
              reasoningOutputTokens: 5,
              totalTokens: 260,
              hasInferredPricing: false
            }
          ]
        }
      ],
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'gpt-5',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 5,
          totalTokens: 130,
          hasInferredPricing: false
        },
        {
          day: '2026-04-09',
          model: 'gpt-5.2-codex',
          projectKey: 'cwd:/outside/repo',
          projectLabel: 'outside/repo',
          repoId: null,
          worktreeId: null,
          eventCount: 1,
          inputTokens: 200,
          cachedInputTokens: 40,
          outputTokens: 60,
          reasoningOutputTokens: 5,
          totalTokens: 260,
          hasInferredPricing: false
        }
      ]
    })

    const breakdown = await store.getBreakdown('orca', '30d', 'model')
    const recentSessions = await store.getRecentSessions('orca', '30d', 10)

    expect(breakdown.find((row) => row.key === 'gpt-5')?.sessions).toBe(1)
    expect(breakdown.find((row) => row.key === 'gpt-5.2-codex')).toBeUndefined()
    expect(recentSessions[0]?.projectLabel).toBe('Repo')
    expect(recentSessions[0]?.model).toBe('gpt-5')
  })

  it('drops persisted caches from older schemas that lack scoped model breakdown data', () => {
    const normalized = normalizePersistedState({
      schemaVersion: 1,
      processedFiles: [],
      sessions: [
        {
          sessionId: 'legacy',
          firstTimestamp: '2026-04-09T10:00:00.000Z',
          lastTimestamp: '2026-04-09T10:10:00.000Z',
          primaryModel: 'gpt-5',
          hasMixedModels: false,
          primaryProjectLabel: 'Repo',
          hasMixedLocations: false,
          primaryWorktreeId: 'repo-1::/workspace/repo',
          primaryRepoId: 'repo-1',
          eventCount: 1,
          totalInputTokens: 1,
          totalCachedInputTokens: 0,
          totalOutputTokens: 1,
          totalReasoningOutputTokens: 0,
          totalTokens: 2,
          hasInferredPricing: false,
          locationBreakdown: [],
          modelBreakdown: []
        }
      ],
      dailyAggregates: [],
      scanState: {
        enabled: true,
        lastScanStartedAt: 1,
        lastScanCompletedAt: 2,
        lastScanError: null
      }
    } as unknown as CodexUsagePersistedState)

    expect(normalized).toEqual({
      schemaVersion: 2,
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
    })
  })
})
