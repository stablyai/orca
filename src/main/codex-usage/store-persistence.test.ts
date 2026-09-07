import { readFileSync } from 'node:fs'
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

vi.mock('./scanner', () => ({
  scanCodexUsageFiles: vi.fn()
}))

import { normalizePersistedState } from './store'
import { scanCodexUsageFiles } from './scanner'

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
    expect(scanCodexUsageFiles).toHaveBeenCalledWith([], [])
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
      schemaVersion: 5,
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
})
