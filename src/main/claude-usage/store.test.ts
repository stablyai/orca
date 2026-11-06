import { mkdtempSync, rmSync } from 'node:fs'
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
  scanClaudeUsageFilesViaWorker: vi.fn(),
  splitUsageCacheFileViaWorker: vi.fn()
}))

import { ClaudeUsageStore, initClaudeUsagePath } from './store'
import { scanClaudeUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'

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

    expect((await usage).status).toBe('known')
    expect((await usage).providerSessionId).toBe('session-1')
  })
})
