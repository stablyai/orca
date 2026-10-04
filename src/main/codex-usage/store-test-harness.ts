import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { scanCodexUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'
import { CodexUsageStore, initCodexUsagePath } from './store'
import type { CodexUsagePersistedState } from './types'

export function createEmptyScanResult() {
  return {
    processedFiles: [],
    sessions: [],
    dailyAggregates: []
  }
}

/** One completed session in `worktreeId`, shaped for automation-run attribution. */
export function createWorktreeUsageSession(worktreeId: string) {
  const tokens = {
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
  return {
    sessionId: 'session-1',
    firstTimestamp: '2026-04-10T15:00:00.000Z',
    lastTimestamp: '2026-04-10T15:05:00.000Z',
    primaryModel: 'gpt-5',
    hasMixedModels: false,
    primaryProjectLabel: 'Repo',
    hasMixedLocations: false,
    primaryWorktreeId: worktreeId,
    primaryRepoId: 'repo-1',
    totalInputTokens: 1000,
    totalCachedInputTokens: 400,
    totalOutputTokens: 250,
    totalReasoningOutputTokens: 100,
    ...tokens,
    locationBreakdown: [
      {
        locationKey: `worktree:${worktreeId}`,
        projectLabel: 'Repo',
        repoId: 'repo-1',
        worktreeId,
        ...tokens
      }
    ],
    modelBreakdown: [{ modelKey: 'gpt-5', modelLabel: 'gpt-5', ...tokens }],
    locationModelBreakdown: [
      {
        locationKey: `worktree:${worktreeId}`,
        modelKey: 'gpt-5',
        modelLabel: 'gpt-5',
        repoId: 'repo-1',
        worktreeId,
        ...tokens
      }
    ]
  }
}

export function createStoreWithState(state: Partial<CodexUsagePersistedState>): CodexUsageStore {
  const store = new CodexUsageStore({
    getRepos: () => [],
    getAllWorktreeMeta: () => ({})
  })

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

/** Registers the shared temp-userdata + fake-timer lifecycle; caller owns the hoisted electron mock. */
export function setupCodexUsageStoreEnv(getPathMock: Mock): { tempUserData: string } {
  const env = { tempUserData: '' }

  beforeEach(() => {
    env.tempUserData = mkdtempSync(join(tmpdir(), 'orca-codex-usage-store-'))
    getPathMock.mockReturnValue(env.tempUserData)
    initCodexUsagePath()
    vi.mocked(scanCodexUsageFilesViaWorker).mockReset()
    vi.mocked(scanCodexUsageFilesViaWorker).mockResolvedValue(createEmptyScanResult())
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-10T12:00:00.000-04:00'))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(env.tempUserData, { recursive: true, force: true })
  })

  return env
}
