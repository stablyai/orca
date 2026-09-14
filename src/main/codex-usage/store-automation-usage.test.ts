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

describe('CodexUsageStore', () => {
  setupCodexUsageStoreEnv(getPathMock)

  it('returns automation usage for a single matching worktree session', async () => {
    const worktreeId = 'repo-1::/workspace/repo'
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
          firstTimestamp: '2026-04-10T15:00:00.000Z',
          lastTimestamp: '2026-04-10T15:05:00.000Z',
          primaryModel: 'gpt-5',
          hasMixedModels: false,
          primaryProjectLabel: 'Repo',
          hasMixedLocations: false,
          primaryWorktreeId: worktreeId,
          primaryRepoId: 'repo-1',
          eventCount: 1,
          totalInputTokens: 1000,
          totalCachedInputTokens: 400,
          totalOutputTokens: 250,
          totalReasoningOutputTokens: 100,
          totalTokens: 1250,
          hasInferredPricing: false,
          locationBreakdown: [
            {
              locationKey: `worktree:${worktreeId}`,
              projectLabel: 'Repo',
              repoId: 'repo-1',
              worktreeId,
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
              locationKey: `worktree:${worktreeId}`,
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              repoId: 'repo-1',
              worktreeId,
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
      ]
    })
    const refreshMock = vi.fn().mockResolvedValue({
      enabled: true,
      isScanning: false,
      lastScanStartedAt: 1,
      lastScanCompletedAt: 2,
      lastScanError: null,
      hasAnyCodexData: true
    })
    ;(store as unknown as { refresh: typeof store.refresh }).refresh = refreshMock
    const completedAt = new Date('2026-04-10T15:06:00.000Z').getTime()
    const request = {
      worktreeId,
      terminalSessionId: 'tab-1',
      startedAt: new Date('2026-04-10T14:59:00.000Z').getTime(),
      completedAt
    }

    const usage = await store.getAutomationRunUsage(request)

    expect(usage.status).toBe('known')
    expect(usage.providerSessionId).toBe('session-1')
    expect(usage.cacheReadTokens).toBe(400)
    expect(usage.reasoningOutputTokens).toBe(100)
    expect(usage.estimatedCostUsd).toBeCloseTo(0.0033)
    expect(refreshMock).toHaveBeenCalledWith(true)

    ;(store as unknown as { state: CodexUsagePersistedState }).state.scanState.lastScanCompletedAt =
      completedAt + 1000
    refreshMock.mockClear()
    await store.getAutomationRunUsage(request)

    expect(refreshMock).toHaveBeenCalledWith(false)
  })
})
