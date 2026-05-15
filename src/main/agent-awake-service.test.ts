import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentAwakeService, AGENT_AWAKE_STATUS_STALE_AFTER_MS } from './agent-awake-service'
import type { AgentAwakeStatus } from './agent-awake-service'

vi.mock('electron', () => ({
  powerSaveBlocker: {
    start: vi.fn(),
    stop: vi.fn(),
    isStarted: vi.fn()
  }
}))

function workingStatus(overrides: Partial<AgentAwakeStatus> = {}): AgentAwakeStatus {
  return {
    state: 'working',
    receivedAt: 1_000,
    observedInCurrentRuntime: true,
    ...overrides
  }
}

function createBlocker() {
  const startedIds = new Set<number>()
  let nextId = 1
  return {
    start: vi.fn(() => {
      const id = nextId++
      startedIds.add(id)
      return id
    }),
    stop: vi.fn((id: number) => {
      startedIds.delete(id)
    }),
    isStarted: vi.fn((id: number) => startedIds.has(id)),
    startedIds
  }
}

function createService(now: () => number, blocker = createBlocker()): AgentAwakeService {
  return new AgentAwakeService({
    blocker,
    now,
    logger: {
      debug: vi.fn(),
      warn: vi.fn()
    }
  })
}

describe('AgentAwakeService', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('does not start when disabled even with a running status', () => {
    const blocker = createBlocker()
    const service = createService(() => 1_000, blocker)

    service.setStatuses([workingStatus()])

    expect(blocker.start).not.toHaveBeenCalled()
  })

  it('starts one prevent-app-suspension blocker when enabled with a fresh working status', () => {
    const blocker = createBlocker()
    const service = createService(() => 1_000, blocker)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])

    expect(blocker.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension')
  })

  it('starts and stops from settings flips around an already-running status', () => {
    const blocker = createBlocker()
    const service = createService(() => 1_000, blocker)

    service.setStatuses([workingStatus()])
    service.setEnabled(true)
    service.setEnabled(false)

    expect(blocker.start).toHaveBeenCalledTimes(1)
    expect(blocker.stop).toHaveBeenCalledWith(1)
  })

  it('ignores startup-hydrated working statuses that were not observed in this runtime', () => {
    const blocker = createBlocker()
    const service = createService(() => 1_000, blocker)

    service.setEnabled(true)
    service.setStatuses([workingStatus({ observedInCurrentRuntime: false })])

    expect(blocker.start).not.toHaveBeenCalled()
  })

  it('does not start for blocked, waiting, or done statuses', () => {
    const blocker = createBlocker()
    const service = createService(() => 1_000, blocker)

    service.setEnabled(true)
    service.setStatuses([
      workingStatus({ state: 'blocked' }),
      workingStatus({ state: 'waiting' }),
      workingStatus({ state: 'done' })
    ])

    expect(blocker.start).not.toHaveBeenCalled()
  })

  it('does not start a second blocker when one working status replaces another', () => {
    const blocker = createBlocker()
    const service = createService(() => 1_000, blocker)

    service.setEnabled(true)
    service.setStatuses([workingStatus({ receivedAt: 1_000 })])
    service.setStatuses([workingStatus({ receivedAt: 1_100 })])

    expect(blocker.start).toHaveBeenCalledTimes(1)
  })

  it('stops when the last running status is dropped', () => {
    const blocker = createBlocker()
    const service = createService(() => 1_000, blocker)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    service.setStatuses([])

    expect(blocker.stop).toHaveBeenCalledWith(1)
  })

  it('does not start for a stale working status', () => {
    const blocker = createBlocker()
    const service = createService(() => AGENT_AWAKE_STATUS_STALE_AFTER_MS + 1_001, blocker)

    service.setEnabled(true)
    service.setStatuses([workingStatus({ receivedAt: 1_000 })])

    expect(blocker.start).not.toHaveBeenCalled()
  })

  it('stops when the only running status becomes stale without another event', () => {
    vi.useFakeTimers()
    let now = 1_000
    const blocker = createBlocker()
    const service = createService(() => now, blocker)

    service.setEnabled(true)
    service.setStatuses([workingStatus({ receivedAt: 1_000 })])
    now = 1_000 + AGENT_AWAKE_STATUS_STALE_AFTER_MS + 1
    vi.advanceTimersByTime(AGENT_AWAKE_STATUS_STALE_AFTER_MS)

    expect(blocker.stop).toHaveBeenCalledWith(1)
    service.dispose()
  })

  it('reschedules stale expiry for a newer running status', () => {
    vi.useFakeTimers()
    let now = 1_000
    const blocker = createBlocker()
    const service = createService(() => now, blocker)

    service.setEnabled(true)
    service.setStatuses([workingStatus({ receivedAt: 1_000 })])
    now = 2_000
    service.setStatuses([workingStatus({ receivedAt: 2_000 })])
    now = 1_000 + AGENT_AWAKE_STATUS_STALE_AFTER_MS + 1
    vi.advanceTimersByTime(AGENT_AWAKE_STATUS_STALE_AFTER_MS)

    expect(blocker.stop).not.toHaveBeenCalled()
    now = 2_000 + AGENT_AWAKE_STATUS_STALE_AFTER_MS + 1
    vi.advanceTimersByTime(1_000)

    expect(blocker.stop).toHaveBeenCalledWith(1)
    service.dispose()
  })

  it('keeps the blocker id when stop fails and Electron reports it is still started', () => {
    const blocker = createBlocker()
    blocker.stop.mockImplementation(() => {
      throw new Error('stop failed')
    })
    const service = createService(() => 1_000, blocker)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    service.setStatuses([])
    service.setStatuses([])

    expect(blocker.stop).toHaveBeenCalledTimes(2)
    expect(blocker.stop).toHaveBeenCalledWith(1)
  })

  it('disposes by clearing timers and stopping an active blocker once', () => {
    vi.useFakeTimers()
    const blocker = createBlocker()
    const service = createService(() => 1_000, blocker)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    service.dispose()
    vi.advanceTimersByTime(AGENT_AWAKE_STATUS_STALE_AFTER_MS)

    expect(blocker.stop).toHaveBeenCalledTimes(1)
    expect(blocker.stop).toHaveBeenCalledWith(1)
  })
})
