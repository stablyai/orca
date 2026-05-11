import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeUsagePersistedState } from './types'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/orca-test-userdata')
  }
}))

import { ClaudeUsageStore } from './store'

function createStoreWithState(state: Partial<ClaudeUsagePersistedState>): ClaudeUsageStore {
  const store = new ClaudeUsageStore({
    getRepos: () => [],
    getWorktreeMeta: () => undefined
  } as never)

  ;(store as unknown as { state: ClaudeUsagePersistedState }).state = {
    schemaVersion: 1,
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

describe('ClaudeUsageStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-09T12:00:00.000-04:00'))
  })

  it('reports no data for Orca scope when only non-Orca usage exists', async () => {
    const store = createStoreWithState({
      sessions: [
        {
          sessionId: 'session-1',
          firstTimestamp: '2026-04-09T10:00:00.000Z',
          lastTimestamp: '2026-04-09T10:10:00.000Z',
          model: 'claude-sonnet-4-6',
          lastCwd: '/outside/repo',
          lastGitBranch: 'feature/outside',
          primaryWorktreeId: null,
          primaryRepoId: null,
          turnCount: 1,
          totalInputTokens: 100,
          totalOutputTokens: 20,
          totalCacheReadTokens: 10,
          totalCacheWriteTokens: 5,
          locationBreakdown: [
            {
              locationKey: 'cwd:/outside/repo',
              projectLabel: 'outside/repo',
              repoId: null,
              worktreeId: null,
              turnCount: 1,
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 10,
              cacheWriteTokens: 5
            }
          ]
        }
      ],
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'claude-sonnet-4-6',
          projectKey: 'cwd:/outside/repo',
          projectLabel: 'outside/repo',
          repoId: null,
          worktreeId: null,
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 10,
          cacheWriteTokens: 5
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.hasAnyClaudeData).toBe(false)
    expect(summary.sessions).toBe(0)
    expect(summary.turns).toBe(0)
    expect(summary.zeroCacheReadTurns).toBe(0)
  })

  it('filters sessions by local calendar day instead of raw UTC date prefixes', async () => {
    const store = createStoreWithState({
      sessions: [
        {
          sessionId: 'session-1',
          firstTimestamp: '2026-04-03T23:40:00.000-04:00',
          lastTimestamp: '2026-04-03T23:55:00.000-04:00',
          model: 'claude-sonnet-4-6',
          lastCwd: '/workspace/repo-a',
          lastGitBranch: 'feature/a',
          primaryWorktreeId: 'repo-1::/workspace/repo-a',
          primaryRepoId: 'repo-1',
          turnCount: 1,
          totalInputTokens: 100,
          totalOutputTokens: 20,
          totalCacheReadTokens: 10,
          totalCacheWriteTokens: 5,
          locationBreakdown: [
            {
              locationKey: 'worktree:repo-1::/workspace/repo-a',
              projectLabel: 'Repo A',
              repoId: 'repo-1',
              worktreeId: 'repo-1::/workspace/repo-a',
              turnCount: 1,
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 10,
              cacheWriteTokens: 5
            }
          ]
        }
      ],
      dailyAggregates: [
        {
          day: '2026-04-03',
          model: 'claude-sonnet-4-6',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 10,
          cacheWriteTokens: 5
        }
      ]
    })

    const recentSessions = await store.getRecentSessions('orca', '7d', 10)

    expect(recentSessions).toHaveLength(1)
    expect(recentSessions[0]?.sessionId).toBe('session-1')
  })

  it('reports zero-cache-read turns from daily aggregates', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'claude-sonnet-4-6',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 5,
          zeroCacheReadTurnCount: 2,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 10,
          cacheWriteTokens: 5
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.turns).toBe(5)
    expect(summary.zeroCacheReadTurns).toBe(2)
  })

  it('prices Claude Opus 4.7 with current Anthropic rates', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'claude-opus-4-7-20260416',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')
    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(summary.estimatedCostUsd).toBeCloseTo(36.75)
    expect(
      breakdown.find((row) => row.key === 'claude-opus-4-7-20260416')?.estimatedCostUsd
    ).toBeCloseTo(36.75)
  })

  it('does not collapse older Opus 4.1 usage into current Opus 4.7 pricing', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'claude-opus-4-1-20250805',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.estimatedCostUsd).toBeCloseTo(110.25)
  })
})
