import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeUsagePersistedState } from './types'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('../usage/usage-scan-worker-spawn', () => ({
  scanClaudeUsageFilesViaWorker: vi.fn()
}))

import { ClaudeUsageStore, initClaudeUsagePath } from './store'
import { scanClaudeUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'
import { aggregateClaudeUsage } from './usage-aggregation'
import { attributeClaudeUsageTurns, buildWorktreeLookup } from './worktree-attribution'

function createBackingStore(): ConstructorParameters<typeof ClaudeUsageStore>[0] {
  return {
    getRepos: () => [],
    getAllWorktreeMeta: () => ({}),
    getFolderWorkspaces: () => [],
    getProjectGroups: () => []
  }
}

function createStoreWithState(
  state: Partial<ClaudeUsagePersistedState>,
  backingStore: Partial<ConstructorParameters<typeof ClaudeUsageStore>[0]> = {}
): ClaudeUsageStore {
  const store = new ClaudeUsageStore({ ...createBackingStore(), ...backingStore })

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

function createWorktreeUsageSession(worktreeId: string) {
  const tokens = {
    turnCount: 1,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 200,
    cacheWriteTokens: 100,
    cacheWrite1hTokens: 0
  }
  return {
    sessionId: 'session-1',
    firstTimestamp: '2026-04-09T15:00:00.000Z',
    lastTimestamp: '2026-04-09T15:05:00.000Z',
    model: 'claude-sonnet-4-6',
    lastCwd: '/workspace/repo-a',
    lastGitBranch: 'feature/a',
    primaryWorktreeId: worktreeId,
    primaryRepoId: 'repo-1',
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    totalCacheReadTokens: 200,
    totalCacheWriteTokens: 100,
    totalCacheWrite1hTokens: 0,
    ...tokens,
    locationBreakdown: [
      {
        locationKey: `worktree:${worktreeId}`,
        projectLabel: 'Repo A',
        repoId: 'repo-1',
        worktreeId,
        ...tokens
      }
    ]
  }
}

describe('ClaudeUsageStore', () => {
  let tempUserData: string

  beforeEach(() => {
    tempUserData = mkdtempSync(join(tmpdir(), 'orca-claude-usage-store-'))
    getPathMock.mockReturnValue(tempUserData)
    initClaudeUsagePath()
    vi.mocked(scanClaudeUsageFilesViaWorker).mockReset()
    vi.mocked(scanClaudeUsageFilesViaWorker).mockResolvedValue({
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

  it('attributes folder-workspace sessions to their workspace under the Orca scope', async () => {
    const folderPath = '/outside/plain-folder'
    const store = createStoreWithState(
      {
        scanState: {
          enabled: true,
          lastScanStartedAt: null,
          lastScanCompletedAt: null,
          lastScanError: null
        }
      },
      {
        getFolderWorkspaces: () => [
          {
            id: 'workspace-1',
            projectGroupId: 'group-1',
            name: 'Plain Folder',
            folderPath,
            connectionId: null,
            linkedTask: null,
            comment: '',
            isArchived: false,
            isUnread: false,
            isPinned: false,
            sortOrder: 0,
            lastActivityAt: 0,
            createdAt: 0,
            updatedAt: 0
          }
        ]
      }
    )
    // Why: attribute through the real worktree lookup so a scan that never
    // receives the folder-workspace ref still falls back to a null worktreeId.
    vi.mocked(scanClaudeUsageFilesViaWorker).mockImplementation(async (worktrees) => ({
      processedFiles: [],
      ...aggregateClaudeUsage(
        await attributeClaudeUsageTurns(
          [
            {
              sessionId: 'session-1',
              timestamp: '2026-04-09T14:00:00.000Z',
              model: 'claude-sonnet-4-6',
              cwd: folderPath,
              gitBranch: null,
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 10,
              cacheWriteTokens: 5,
              cacheWrite1hTokens: 0
            }
          ],
          await buildWorktreeLookup(worktrees)
        )
      )
    }))

    const summary = await store.getSummary('orca', '30d')

    expect(vi.mocked(scanClaudeUsageFilesViaWorker).mock.calls[0]?.[0]).toContainEqual({
      repoId: 'folder-workspace:group-1',
      worktreeId: 'folder:workspace-1',
      path: folderPath,
      displayName: 'Plain Folder'
    })
    // Why: the Orca scope drops null worktreeIds, so surviving rows prove attribution.
    expect(summary.sessions).toBe(1)
    expect(summary.turns).toBe(1)
    expect(summary.inputTokens).toBe(100)
    expect(summary.topProject).toBe('Plain Folder')
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
      sessions: [createWorktreeUsageSession(worktreeId)]
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

  it('forces one scan per run and stops re-forcing after a failed attempt', async () => {
    const completedAt = Date.parse('2026-04-09T15:06:00.000Z')
    const scanError = 'EMFILE: too many open files'
    const failedScanState = (lastScanStartedAt: number) => ({
      enabled: true,
      lastScanStartedAt,
      lastScanCompletedAt: completedAt - 60_000,
      lastScanError: scanError
    })
    const scanStateResult = {
      enabled: true,
      isScanning: false,
      lastScanStartedAt: completedAt - 60_000,
      lastScanCompletedAt: completedAt - 60_000,
      lastScanError: scanError,
      hasAnyClaudeData: false
    }
    const request = {
      worktreeId: 'repo-1::/workspace/repo-a',
      terminalSessionId: 'tab-1',
      startedAt: completedAt - 120_000,
      completedAt
    }

    const beforeAttempt = createStoreWithState({
      scanState: failedScanState(completedAt - 60_000)
    })
    const beforeRefresh = vi.spyOn(beforeAttempt, 'refresh').mockResolvedValue(scanStateResult)
    await beforeAttempt.getAutomationRunUsage(request)

    expect(beforeRefresh).toHaveBeenCalledWith(true)

    // That forced scan failed: it recorded an attempt but no completion. Later
    // lookups must not keep forcing a full rescan of all Claude history.
    const afterAttempt = createStoreWithState({ scanState: failedScanState(completedAt + 1000) })
    const afterRefresh = vi.spyOn(afterAttempt, 'refresh').mockResolvedValue(scanStateResult)
    const usage = await afterAttempt.getAutomationRunUsage(request)

    expect(afterRefresh).toHaveBeenCalledWith(false)
    expect(usage.unavailableReason).toBe('scan_failed')
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

    expect(scanClaudeUsageFilesViaWorker).toHaveBeenCalledWith([], [])
    expect(readFileSync(join(tempUserData, 'orca-claude-usage.json'), 'utf-8')).toContain('\n')
  })

  it('joins a scan that is already in flight when the run finished before it started', async () => {
    const worktreeId = 'repo-1::/workspace/repo-a'
    const store = createStoreWithState({
      scanState: {
        enabled: true,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null
      }
    })
    // Prime the worktree fingerprint so an unforced refresh can return early.
    vi.mocked(scanClaudeUsageFilesViaWorker).mockResolvedValue({
      processedFiles: [],
      sessions: [],
      dailyAggregates: []
    })
    await store.refresh(true)

    const completedAt = Date.now() + 10_000
    vi.setSystemTime(new Date(completedAt + 1_000))

    let startScan = () => {}
    let finishScan = () => {}
    const scanStarted = new Promise<void>((resolve) => {
      startScan = resolve
    })
    const scanFinished = new Promise<void>((resolve) => {
      finishScan = resolve
    })
    vi.mocked(scanClaudeUsageFilesViaWorker).mockImplementationOnce(async () => {
      startScan()
      await scanFinished
      return {
        processedFiles: [],
        sessions: [createWorktreeUsageSession(worktreeId)],
        dailyAggregates: []
      }
    })

    const inFlight = store.refresh(true)
    await scanStarted

    const usage = store.getAutomationRunUsage({
      worktreeId,
      terminalSessionId: 'session-1',
      startedAt: completedAt - 60_000,
      completedAt
    })
    finishScan()
    await inFlight

    // The in-flight scan's start time is not a finished attempt, so the lookup
    // forces and rides that scan instead of reading a pre-run cache.
    expect((await usage).status).toBe('known')
    expect((await usage).providerSessionId).toBe('session-1')
  })
})
