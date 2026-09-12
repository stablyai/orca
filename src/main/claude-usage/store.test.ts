import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeUsagePersistedState } from './types'
import type * as Scanner from './scanner'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('./scanner', async (importOriginal) => ({
  ...(await importOriginal<typeof Scanner>()),
  scanClaudeUsageFiles: vi.fn()
}))

import { ClaudeUsageStore, initClaudeUsagePath } from './store'
import { scanClaudeUsageFiles } from './scanner'

function createBackingStore(): ConstructorParameters<typeof ClaudeUsageStore>[0] {
  return {
    getRepos: () => [],
    getAllWorktreeMeta: () => ({})
  }
}

function createStoreWithState(state: Partial<ClaudeUsagePersistedState>): ClaudeUsageStore {
  const store = new ClaudeUsageStore(createBackingStore())

  ;(store as unknown as { state: ClaudeUsagePersistedState }).state = {
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

describe('ClaudeUsageStore', () => {
  let tempUserData: string

  beforeEach(() => {
    tempUserData = mkdtempSync(join(tmpdir(), 'orca-claude-usage-store-'))
    getPathMock.mockReturnValue(tempUserData)
    initClaudeUsagePath()
    vi.mocked(scanClaudeUsageFiles).mockReset()
    vi.mocked(scanClaudeUsageFiles).mockResolvedValue({
      processedFiles: [],
      sessions: [],
      dailyAggregates: []
    })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-09T12:00:00.000-04:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(tempUserData, { recursive: true, force: true })
  })

  it('defaults a null legacy opt-in while invalidating the cache', () => {
    writeFileSync(
      join(tempUserData, 'orca-claude-usage.json'),
      JSON.stringify({ schemaVersion: 4, scanState: { enabled: null } })
    )

    const store = new ClaudeUsageStore(createBackingStore())

    expect(store.getScanState().enabled).toBe(false)
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
          totalCacheWrite1hTokens: 0,
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
              cacheWriteTokens: 5,
              cacheWrite1hTokens: 0
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
          cacheWriteTokens: 5,
          cacheWrite1hTokens: 0
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
          totalCacheWrite1hTokens: 0,
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
              cacheWriteTokens: 5,
              cacheWrite1hTokens: 0
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
          cacheWriteTokens: 5,
          cacheWrite1hTokens: 0
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
          cacheWriteTokens: 5,
          cacheWrite1hTokens: 0
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
          cacheWriteTokens: 1_000_000,
          cacheWrite1hTokens: 0
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

  it('prices the 1-hour cache-write share above the 5-minute rate', async () => {
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
          cacheWriteTokens: 1_000_000,
          cacheWrite1hTokens: 400_000
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')
    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    // 5 + 25 + 0.5 + (0.6 * 6.25 + 0.4 * 10); the flat 5m rate would give 36.75.
    expect(summary.estimatedCostUsd).toBeCloseTo(38.25)
    expect(
      breakdown.find((row) => row.key === 'claude-opus-4-7-20260416')?.estimatedCostUsd
    ).toBeCloseTo(38.25)
  })

  it('prices Claude Opus 4.8 with current Anthropic rates', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'anthropic/claude-opus-4-8-20260528',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
          cacheWrite1hTokens: 0
        },
        {
          day: '2026-04-09',
          model: 'claude-opus-4.8-20260528',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
          cacheWrite1hTokens: 0
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')
    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(summary.estimatedCostUsd).toBeCloseTo(73.5)
    expect(
      breakdown.find((row) => row.key === 'anthropic/claude-opus-4-8-20260528')?.estimatedCostUsd
    ).toBeCloseTo(36.75)
    expect(
      breakdown.find((row) => row.key === 'claude-opus-4.8-20260528')?.estimatedCostUsd
    ).toBeCloseTo(36.75)
  })

  it('prices Claude 5 family models with current Anthropic rates', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'claude-opus-5',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
          cacheWrite1hTokens: 0
        },
        {
          day: '2026-04-09',
          model: 'anthropic/claude-fable-5',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
          cacheWrite1hTokens: 0
        },
        {
          day: '2026-04-09',
          model: 'claude-sonnet-5-thinking',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
          cacheWrite1hTokens: 0
        }
      ]
    })

    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(breakdown.find((row) => row.key === 'claude-opus-5')?.estimatedCostUsd).toBeCloseTo(
      36.75
    )
    expect(
      breakdown.find((row) => row.key === 'anthropic/claude-fable-5')?.estimatedCostUsd
    ).toBeCloseTo(73.5)
    expect(
      breakdown.find((row) => row.key === 'claude-sonnet-5-thinking')?.estimatedCostUsd
    ).toBeCloseTo(14.7)
  })

  it('prices Sonnet 5 long-context usage at flat rates', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'claude-sonnet-5',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 300_000,
          outputTokens: 300_000,
          cacheReadTokens: 300_000,
          cacheWriteTokens: 300_000,
          cacheWrite1hTokens: 0
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    // Why: Sonnet 4.6 and earlier bill above 200k at a premium; Sonnet 5 does not.
    expect(summary.estimatedCostUsd).toBeCloseTo(4.41)
  })

  it('does not collapse Opus 4.5 or Sonnet 4.5 usage into Claude 5 pricing', async () => {
    const store = createStoreWithState({
      dailyAggregates: ['claude-sonnet-4-5-20250929', 'claude-opus-4-5-20251101'].map((model) => ({
        day: '2026-04-09',
        model,
        projectKey: 'worktree:repo-1::/workspace/repo-a',
        projectLabel: 'Repo A',
        repoId: 'repo-1',
        worktreeId: 'repo-1::/workspace/repo-a',
        turnCount: 1,
        zeroCacheReadTurnCount: 0,
        inputTokens: 300_000,
        outputTokens: 300_000,
        cacheReadTokens: 300_000,
        cacheWriteTokens: 300_000,
        cacheWrite1hTokens: 0
      }))
    })

    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    // Why: the 4.5 tier premium only survives if `-4-5-` never matches the `-5`
    // family regex, so this doubles as the digit-boundary proof for both families.
    expect(
      breakdown.find((row) => row.key === 'claude-sonnet-4-5-20250929')?.estimatedCostUsd
    ).toBeCloseTo(8.07)
    // Why: Opus 4.5 and Opus 5 share rates today, so this pins the rate rather
    // than the routing — it fails only if the two ever diverge.
    expect(
      breakdown.find((row) => row.key === 'claude-opus-4-5-20251101')?.estimatedCostUsd
    ).toBeCloseTo(11.025)
  })

  it('prices unknown newer Opus 4 point releases with current Opus rates', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'claude-opus-4-9-20260630',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
          cacheWrite1hTokens: 0
        },
        {
          day: '2026-04-09',
          model: 'claude-opus-4.10-20260715',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
          cacheWrite1hTokens: 0
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.estimatedCostUsd).toBeCloseTo(73.5)
  })

  it('does not collapse older Opus 4.1 or base Opus 4 usage into current Opus pricing', async () => {
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
          cacheWriteTokens: 1_000_000,
          cacheWrite1hTokens: 0
        },
        {
          day: '2026-04-09',
          model: 'claude-opus-4-20250514',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000,
          cacheWrite1hTokens: 0
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.estimatedCostUsd).toBeCloseTo(220.5)
  })

  it('prices Sonnet 4.6 long-context usage at its flat 1M-window rates', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'claude-sonnet-4.6-20260217',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 300_000,
          outputTokens: 300_000,
          cacheReadTokens: 300_000,
          cacheWriteTokens: 300_000,
          cacheWrite1hTokens: 0
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.estimatedCostUsd).toBeCloseTo(6.615)
  })

  it('returns automation usage for a single matching worktree session', async () => {
    const worktreeId = 'repo-1::/workspace/repo-a'
    const completedAt = Date.parse('2026-04-09T15:06:00.000Z')
    const store = createStoreWithState({
      scanState: {
        enabled: true,
        lastScanStartedAt: 1,
        lastScanCompletedAt: 2,
        lastScanError: null
      },
      sessions: [
        {
          sessionId: 'session-1',
          firstTimestamp: '2026-04-09T15:00:00.000Z',
          lastTimestamp: '2026-04-09T15:05:00.000Z',
          model: 'claude-sonnet-4-6',
          lastCwd: '/workspace/repo-a',
          lastGitBranch: 'feature/a',
          primaryWorktreeId: worktreeId,
          primaryRepoId: 'repo-1',
          turnCount: 1,
          totalInputTokens: 1000,
          totalOutputTokens: 500,
          totalCacheReadTokens: 200,
          totalCacheWriteTokens: 100,
          totalCacheWrite1hTokens: 0,
          locationBreakdown: [
            {
              locationKey: `worktree:${worktreeId}`,
              projectLabel: 'Repo A',
              repoId: 'repo-1',
              worktreeId,
              turnCount: 1,
              inputTokens: 1000,
              outputTokens: 500,
              cacheReadTokens: 200,
              cacheWriteTokens: 100,
              cacheWrite1hTokens: 0
            }
          ]
        }
      ]
    })
    const refreshMock = vi.fn().mockResolvedValue({
      enabled: true,
      isScanning: false,
      lastScanStartedAt: 1,
      lastScanCompletedAt: 2,
      lastScanError: null,
      hasAnyClaudeData: true
    })
    ;(store as unknown as { refresh: typeof store.refresh }).refresh = refreshMock
    const request = {
      worktreeId,
      terminalSessionId: 'tab-1',
      startedAt: completedAt - 7 * 60_000,
      completedAt
    }

    const usage = await store.getAutomationRunUsage(request)

    expect(usage.status).toBe('known')
    expect(usage.providerSessionId).toBe('session-1')
    expect(usage.totalTokens).toBe(1800)
    expect(usage.estimatedCostUsd).toBeCloseTo(0.010935)
    expect(refreshMock).toHaveBeenCalledWith(true)

    ;(
      store as unknown as { state: ClaudeUsagePersistedState }
    ).state.scanState.lastScanCompletedAt = completedAt + 1000
    refreshMock.mockClear()
    await store.getAutomationRunUsage(request)

    expect(refreshMock).toHaveBeenCalledWith(false)
  })

  it('adapts Claude scans to pretty-printed cache persistence', async () => {
    const store = createStoreWithState({
      schemaVersion: 5,
      scanState: {
        enabled: true,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null
      }
    })

    await store.refresh(true)

    expect(scanClaudeUsageFiles).toHaveBeenCalledWith([], [])
    expect(readFileSync(join(tempUserData, 'orca-claude-usage.json'), 'utf-8')).toContain('\n')
  })
})
