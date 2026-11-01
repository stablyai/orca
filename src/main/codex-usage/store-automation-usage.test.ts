import { describe, expect, it, vi } from 'vitest'

import { scanCodexUsageFilesViaWorker } from '../usage/usage-scan-worker-spawn'
import {
  createStoreWithState,
  createWorktreeUsageSession,
  setupCodexUsageStoreEnv
} from './store-test-harness'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('../usage/usage-scan-worker-spawn', () => ({
  scanCodexUsageFilesViaWorker: vi.fn(),
  splitUsageCacheFileViaWorker: vi.fn()
}))

describe('CodexUsageStore', () => {
  setupCodexUsageStoreEnv(getPathMock)

  it('joins a scan that is already in flight when the run finished before it started', async () => {
    const worktreeId = 'repo-1::/workspace/repo'
    const store = createStoreWithState({
      scanState: {
        enabled: true,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null
      }
    })
    // Prime the fingerprint so an unforced refresh can return early.
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
    vi.mocked(scanCodexUsageFilesViaWorker).mockImplementationOnce(async () => {
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

    expect((await usage).status).toBe('known')
    expect((await usage).providerSessionId).toBe('session-1')
  })
})
