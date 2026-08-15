import { describe, expect, it, vi } from 'vitest'
import { waitForHeadlessAgentLaunch } from './headless-launch-observer'

describe('waitForHeadlessAgentLaunch', () => {
  it('accepts a valid launch with no pane key', async () => {
    await expect(
      waitForHeadlessAgentLaunch({
        paneKey: null,
        agentType: 'codex',
        launchedAt: 10,
        deadlineAt: 20,
        getStatusSnapshotForPane: vi.fn()
      })
    ).resolves.toBeUndefined()
  })

  it('uses the persisted deadline and ignores a cached pre-launch status', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    const readStatus = vi
      .fn()
      .mockReturnValueOnce([{ agentType: 'codex', receivedAt: 99 }])
      .mockReturnValue([{ agentType: 'codex', receivedAt: 100 }])
    const ready = waitForHeadlessAgentLaunch({
      paneKey: 'physical-pane',
      agentType: 'codex',
      launchedAt: 100,
      deadlineAt: 200,
      getStatusSnapshotForPane: readStatus
    })

    await vi.advanceTimersByTimeAsync(250)
    await expect(ready).resolves.toBeUndefined()
    expect(readStatus).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('rejects when the injected deadline expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(100)
    const ready = waitForHeadlessAgentLaunch({
      paneKey: 'pane-1',
      agentType: 'codex',
      launchedAt: 100,
      deadlineAt: 150,
      getStatusSnapshotForPane: () => []
    })

    const rejected = expect(ready).rejects.toThrow('did not report a launch status')
    await vi.advanceTimersByTimeAsync(250)
    await rejected
    vi.useRealTimers()
  })
})
