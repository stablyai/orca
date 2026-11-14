import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acknowledgeWatcherSubscribe as ackSubscribe,
  currentWatcherChild,
  FakeWatcherChild as FakeChild
} from '../supervision/parcel-watcher-process-test-child'

const { forkMock, existsSyncMock } = vi.hoisted(() => ({
  forkMock: vi.fn(),
  existsSyncMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdtempSync: vi.fn(() => '/tmp/orca-watcher-canary-health-test'),
  rmSync: vi.fn()
}))

import {
  CANARY_STALL_BACKOFF_INITIAL_MS,
  CANARY_STALL_BACKOFF_MAX_MS
} from './parcel-watcher-delivery-canary'

import { createWatcherProcessSupervisor } from '../parcel-watcher-process'

describe('watcher delivery stall reporting', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('VITEST', '')
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    existsSyncMock.mockReturnValue(true)
    forkMock.mockImplementation(() => new FakeChild())
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it('asks callers to rescan during a long stall and once more on recovery', async () => {
    const supervisor = createWatcherProcessSupervisor()
    const onOverflow = vi.fn()
    const subscription = supervisor.subscribe('/repo', vi.fn(), {}, { onOverflow })
    const child = currentWatcherChild(forkMock)
    ackSubscribe(child)
    await subscription

    child.emit('message', { op: 'delivery-health', state: 'stalled' })
    // A stall shorter than one backoff period is ordinary latency.
    await vi.advanceTimersByTimeAsync(CANARY_STALL_BACKOFF_INITIAL_MS - 1)
    expect(onOverflow).not.toHaveBeenCalled()

    // Rescans back off with the canary: 30 s, then 60, 120, 240, capped at 300.
    const rescanTimes: number[] = []
    onOverflow.mockImplementation(() => rescanTimes.push(Date.now()))
    const stalledAt = Date.now() - (CANARY_STALL_BACKOFF_INITIAL_MS - 1)
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(rescanTimes.map((time) => (time - stalledAt) / 1000)).toEqual([
      30, 90, 210, 450, 750, 1050
    ])

    child.emit('message', { op: 'delivery-health', state: 'healthy' })
    expect(onOverflow).toHaveBeenCalledTimes(7)
    await vi.advanceTimersByTimeAsync(CANARY_STALL_BACKOFF_MAX_MS * 2)
    expect(onOverflow).toHaveBeenCalledTimes(7)
    supervisor.dispose()
  })
})
