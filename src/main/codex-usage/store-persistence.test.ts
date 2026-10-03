import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CodexUsagePersistedState } from './types'
import { createStoreWithState, setupCodexUsageStoreEnv } from './store-test-harness'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('../usage/usage-scan-worker-spawn', () => ({
  scanCodexUsageFilesViaWorker: vi.fn()
}))

import { CodexUsageStore, normalizePersistedState } from './store'
import { scanCodexUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'

describe('CodexUsageStore', () => {
  const storeEnv = setupCodexUsageStoreEnv(getPathMock)

  it('adapts Codex scans to compact cache persistence', async () => {
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

    const persistedJson = readFileSync(
      join(storeEnv.tempUserData, 'orca-codex-usage.json'),
      'utf-8'
    )
    expect(scanCodexUsageFilesViaWorker).toHaveBeenCalledWith([], [])
    expect(persistedJson).toBe(JSON.stringify(JSON.parse(persistedJson)))
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
      schemaVersion: 6,
      worktreeFingerprint: null,
      processedFiles: [],
      sessions: [],
      dailyAggregates: [],
      scanState: {
        enabled: true,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null
      }
    })
  })

  it('rescans from scratch when the cache predates per-request long-context counts', async () => {
    const processedFile = {
      path: '/codex/sessions/rollout-1.jsonl',
      mtimeMs: 1,
      size: 10,
      sessions: [],
      dailyAggregates: [],
      ownedEventKeys: [],
      hasDeferredClaims: false,
      parseResumeState: null
    }
    const scanMock = vi.mocked(scanCodexUsageFilesViaWorker)
    scanMock.mockResolvedValue({
      processedFiles: [processedFile],
      sessions: [],
      dailyAggregates: []
    })
    const cacheFile = join(storeEnv.tempUserData, 'orca-codex-usage.json')
    const backingStore = {
      getRepos: () => [],
      getAllWorktreeMeta: () => ({}),
      getFolderWorkspaces: () => [],
      getProjectGroups: () => []
    }
    const seeded = new CodexUsageStore(backingStore)
    await seeded.setEnabled(true)
    await seeded.refresh(true)
    await seeded.flush()
    const current = readFileSync(cacheFile, 'utf-8')

    scanMock.mockClear()
    await new CodexUsageStore(backingStore).refresh(true)
    // Control: a current-schema cache hands its processed files back for reuse.
    expect(scanMock).toHaveBeenLastCalledWith([], [processedFile])

    writeFileSync(cacheFile, JSON.stringify({ ...JSON.parse(current), schemaVersion: 5 }))
    scanMock.mockClear()
    await new CodexUsageStore(backingStore).refresh(false)
    expect(scanMock).toHaveBeenLastCalledWith([], [])
  })
})
