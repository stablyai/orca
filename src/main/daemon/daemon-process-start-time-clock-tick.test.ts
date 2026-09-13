import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runProcessMock, runProcessSyncMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  runProcessSyncMock: vi.fn()
}))

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))

const CLK_TCK = { code: 0, signal: null, stdout: '100\n', stderr: '', timedOut: false }

import {
  getProcessStartedAtMs,
  getProcessStartedAtMsAsync,
  resetProcessStartTimeClockTickCache
} from './daemon-process-start-time'

describe('CLK_TCK probe', () => {
  beforeEach(() => {
    resetProcessStartTimeClockTickCache()
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
    runProcessMock.mockResolvedValue(CLK_TCK)
    runProcessSyncMock.mockReturnValue(CLK_TCK)
  })

  it.runIf(process.platform === 'linux')(
    'forks getconf once per process, never once per liveness check',
    async () => {
      // Why pinned: this runs on every daemon pid verification. CLK_TCK is fixed at
      // kernel build time, so a second spawn is pure event-loop cost.
      expect(getProcessStartedAtMs(process.pid)).toBeGreaterThan(0)
      expect(getProcessStartedAtMs(process.pid)).toBeGreaterThan(0)
      await expect(getProcessStartedAtMsAsync(process.pid)).resolves.toBeGreaterThan(0)

      expect(runProcessSyncMock).toHaveBeenCalledTimes(1)
      expect(runProcessSyncMock.mock.calls[0][0].program).toBe('getconf')
      expect(runProcessMock).not.toHaveBeenCalled()
    }
  )

  it.runIf(process.platform === 'linux')(
    'reads the tick rate through the async runner when the async twin goes first',
    async () => {
      await expect(getProcessStartedAtMsAsync(process.pid)).resolves.toBeGreaterThan(0)
      await expect(getProcessStartedAtMsAsync(process.pid)).resolves.toBeGreaterThan(0)

      expect(runProcessMock).toHaveBeenCalledTimes(1)
      expect(runProcessSyncMock).not.toHaveBeenCalled()
    }
  )

  it.runIf(process.platform === 'linux')(
    'yields null rather than a bogus start time when getconf fails',
    async () => {
      runProcessMock.mockResolvedValue({ ...CLK_TCK, code: 1, stdout: '' })

      // Null is the fail-open input to startTimesWithinTolerance: a failed probe
      // must never become start-time evidence either way.
      await expect(getProcessStartedAtMsAsync(process.pid)).resolves.toBeNull()
    }
  )
})
