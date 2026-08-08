import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_AWAKE_BLOCKER_SWAP_RETRY_MS } from './agent-awake-blocker-swap-retry'
import {
  AgentAwakeService,
  AGENT_AWAKE_DISPLAY_KEEP_AFTER_MS,
  AGENT_AWAKE_STATUS_STALE_AFTER_MS
} from './agent-awake-service'
import type { AgentAwakeStatus } from './agent-awake-service'

vi.mock('electron', () => ({
  powerMonitor: {
    on: vi.fn(),
    off: vi.fn()
  },
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

function createMacosAssertion() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn()
  }
}

function createLinuxAssertion() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn()
  }
}

function createPowerMonitor() {
  const listeners = new Set<() => void>()
  return {
    on: vi.fn((_event: 'resume', listener: () => void) => {
      listeners.add(listener)
    }),
    off: vi.fn((_event: 'resume', listener: () => void) => {
      listeners.delete(listener)
    }),
    emitResume: () => {
      for (const listener of listeners) {
        listener()
      }
    }
  }
}

function createService(
  now: () => number,
  blocker = createBlocker(),
  macosAssertion = createMacosAssertion(),
  linuxAssertion = createLinuxAssertion(),
  powerMonitor: ReturnType<typeof createPowerMonitor> | null = null,
  // Default to darwin (has an independent caffeinate system floor) so the
  // display-downgrade path is exercised deterministically regardless of CI OS.
  platform: NodeJS.Platform = 'darwin'
): AgentAwakeService {
  return new AgentAwakeService({
    blocker,
    linuxAssertion,
    macosAssertion,
    now,
    platform,
    powerMonitor,
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

  it('starts Electron and platform assertions when enabled with a fresh working status', () => {
    const blocker = createBlocker()
    const macosAssertion = createMacosAssertion()
    const linuxAssertion = createLinuxAssertion()
    const service = createService(() => 1_000, blocker, macosAssertion, linuxAssertion)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])

    expect(blocker.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).toHaveBeenCalledWith('prevent-display-sleep')
    expect(macosAssertion.start).toHaveBeenCalledTimes(1)
    expect(linuxAssertion.start).toHaveBeenCalledTimes(1)
  })

  it('keeps the system awake but lets the display sleep for a status quiet past the display window', () => {
    const blocker = createBlocker()
    const macosAssertion = createMacosAssertion()
    const linuxAssertion = createLinuxAssertion()
    // Working status last refreshed longer ago than the display-keep window but
    // still within the 2h system window (e.g. a long silent tool call, or an
    // agent that died with its shell still open).
    const now = 1_000 + AGENT_AWAKE_DISPLAY_KEEP_AFTER_MS + 1
    const service = createService(() => now, blocker, macosAssertion, linuxAssertion)

    service.setEnabled(true)
    service.setStatuses([workingStatus({ receivedAt: 1_000 })])

    expect(blocker.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension')
    expect(macosAssertion.start).toHaveBeenCalledTimes(1)
    expect(linuxAssertion.start).toHaveBeenCalledTimes(1)
  })

  it('downgrades the display assertion to system-only when a working status stops refreshing', () => {
    vi.useFakeTimers()
    let now = 1_000
    const blocker = createBlocker()
    const macosAssertion = createMacosAssertion()
    const linuxAssertion = createLinuxAssertion()
    const service = createService(() => now, blocker, macosAssertion, linuxAssertion)

    service.setEnabled(true)
    service.setStatuses([workingStatus({ receivedAt: 1_000 })])
    expect(blocker.start).toHaveBeenLastCalledWith('prevent-display-sleep')
    // Ignore the setup-time stop that fires while enabling before a status exists.
    macosAssertion.stop.mockClear()
    linuxAssertion.stop.mockClear()

    // Hit the exact boundary: it must be expired here or the scheduler will
    // move directly to the 2h system expiry and leave the display blocker on.
    now = 1_000 + AGENT_AWAKE_DISPLAY_KEEP_AFTER_MS
    vi.advanceTimersByTime(AGENT_AWAKE_DISPLAY_KEEP_AFTER_MS)

    // The display assertion is swapped for a system-only one; the platform
    // (system) assertions are never stopped, so the agent keeps running.
    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(blocker.start).toHaveBeenLastCalledWith('prevent-app-suspension')
    expect(macosAssertion.stop).not.toHaveBeenCalled()
    expect(linuxAssertion.stop).not.toHaveBeenCalled()
    service.dispose()
  })

  it('re-upgrades to prevent-display-sleep when a quiet agent resumes producing status', () => {
    const blocker = createBlocker()
    let now = 1_000 + AGENT_AWAKE_DISPLAY_KEEP_AFTER_MS + 1
    const service = createService(() => now, blocker)

    service.setEnabled(true)
    // Starts in the quiet tier: system-only.
    service.setStatuses([workingStatus({ receivedAt: 1_000 })])
    expect(blocker.start).toHaveBeenLastCalledWith('prevent-app-suspension')

    // A fresh status arrives (agent resumed) -> back to display-sleep.
    service.setStatuses([workingStatus({ receivedAt: now })])
    expect(blocker.start).toHaveBeenLastCalledWith('prevent-display-sleep')
    service.dispose()
  })

  it('retries a transient display->system swap failure without stacking blockers', () => {
    vi.useFakeTimers()
    let now = 1_000
    const blocker = createBlocker()
    const service = createService(() => now, blocker) // darwin (can downgrade)

    service.setEnabled(true)
    service.setStatuses([workingStatus({ receivedAt: 1_000 })]) // fresh -> prevent-display-sleep (id 1)
    expect(blocker.start).toHaveBeenLastCalledWith('prevent-display-sleep')

    // The swap tries to stop id 1 first, but stop fails and Electron still
    // reports it started — the old assertion must NOT be leaked under a new one.
    blocker.stop.mockImplementationOnce(() => {
      throw new Error('stop failed')
    })
    blocker.start.mockClear()

    now = 1_000 + AGENT_AWAKE_DISPLAY_KEEP_AFTER_MS
    vi.advanceTimersByTime(AGENT_AWAKE_DISPLAY_KEEP_AFTER_MS)

    expect(blocker.start).not.toHaveBeenCalled()
    vi.advanceTimersByTime(AGENT_AWAKE_BLOCKER_SWAP_RETRY_MS)

    expect(blocker.stop).toHaveBeenCalledTimes(2)
    expect(blocker.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension')
    service.dispose()
  })

  it('clears a pending blocker-swap retry on dispose', () => {
    vi.useFakeTimers()
    let now = 1_000
    const blocker = createBlocker()
    const service = createService(() => now, blocker)

    service.setEnabled(true)
    service.setStatuses([workingStatus({ receivedAt: 1_000 })])
    blocker.stop.mockImplementationOnce(() => {
      throw new Error('stop failed')
    })
    now = 1_000 + AGENT_AWAKE_DISPLAY_KEEP_AFTER_MS
    vi.advanceTimersByTime(AGENT_AWAKE_DISPLAY_KEEP_AFTER_MS)
    service.dispose()
    blocker.stop.mockClear()

    vi.advanceTimersByTime(AGENT_AWAKE_BLOCKER_SWAP_RETRY_MS)
    expect(blocker.stop).not.toHaveBeenCalled()
  })

  it.each(['win32', 'linux'] as const)(
    'never downgrades the display on %s (only macOS has a canonical system-sleep floor)',
    (platform) => {
      const blocker = createBlocker()
      // Quiet past the display window, but off macOS the display assertion is
      // load-bearing for keeping the system (and agent) awake, so it must NOT
      // be downgraded to prevent-app-suspension.
      const now = 1_000 + AGENT_AWAKE_DISPLAY_KEEP_AFTER_MS + 1
      const service = createService(
        () => now,
        blocker,
        createMacosAssertion(),
        createLinuxAssertion(),
        null,
        platform
      )

      service.setEnabled(true)
      service.setStatuses([workingStatus({ receivedAt: 1_000 })])

      expect(blocker.start).toHaveBeenCalledTimes(1)
      expect(blocker.start).toHaveBeenCalledWith('prevent-display-sleep')
      expect(blocker.start).not.toHaveBeenCalledWith('prevent-app-suspension')
      service.dispose()
    }
  )

  it('starts and stops from settings flips around an already-running status', () => {
    const blocker = createBlocker()
    const macosAssertion = createMacosAssertion()
    const linuxAssertion = createLinuxAssertion()
    const service = createService(() => 1_000, blocker, macosAssertion, linuxAssertion)

    service.setStatuses([workingStatus()])
    service.setEnabled(true)
    service.setEnabled(false)

    expect(blocker.start).toHaveBeenCalledTimes(1)
    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(macosAssertion.start).toHaveBeenCalledTimes(1)
    expect(macosAssertion.stop).toHaveBeenCalled()
    expect(linuxAssertion.start).toHaveBeenCalledTimes(1)
    expect(linuxAssertion.stop).toHaveBeenCalled()
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
    const macosAssertion = createMacosAssertion()
    const linuxAssertion = createLinuxAssertion()
    const service = createService(() => 1_000, blocker, macosAssertion, linuxAssertion)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    service.setStatuses([])

    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(macosAssertion.stop).toHaveBeenCalledWith('status-change')
    expect(linuxAssertion.stop).toHaveBeenCalledWith('status-change')
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
    const macosAssertion = createMacosAssertion()
    const linuxAssertion = createLinuxAssertion()
    const service = createService(() => now, blocker, macosAssertion, linuxAssertion)

    service.setEnabled(true)
    service.setStatuses([workingStatus({ receivedAt: 1_000 })])
    // The exact expiry must release the assertion; otherwise the scheduler has
    // no later boundary to wake it and the blocker can survive indefinitely.
    now = 1_000 + AGENT_AWAKE_STATUS_STALE_AFTER_MS
    vi.advanceTimersByTime(AGENT_AWAKE_STATUS_STALE_AFTER_MS)

    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(macosAssertion.stop).toHaveBeenCalledWith('stale-expiry')
    expect(linuxAssertion.stop).toHaveBeenCalledWith('stale-expiry')
    service.dispose()
  })

  it('reschedules stale expiry for a newer running status', () => {
    vi.useFakeTimers()
    let now = 1_000
    const blocker = createBlocker()
    const macosAssertion = createMacosAssertion()
    const linuxAssertion = createLinuxAssertion()
    const service = createService(() => now, blocker, macosAssertion, linuxAssertion)

    service.setEnabled(true)
    service.setStatuses([workingStatus({ receivedAt: 1_000 })])
    now = 2_000
    service.setStatuses([workingStatus({ receivedAt: 2_000 })])
    // Ignore the setup-time stop that fires while enabling before a status exists.
    macosAssertion.stop.mockClear()
    linuxAssertion.stop.mockClear()
    now = 1_000 + AGENT_AWAKE_STATUS_STALE_AFTER_MS + 1
    vi.advanceTimersByTime(AGENT_AWAKE_STATUS_STALE_AFTER_MS)

    // The system is still kept awake because the newer status is within its own
    // 2h window. (The Electron blocker may have swapped display->system type by
    // now; the platform assertions are the true "still awake" signal.)
    expect(macosAssertion.stop).not.toHaveBeenCalled()
    expect(linuxAssertion.stop).not.toHaveBeenCalled()
    now = 2_000 + AGENT_AWAKE_STATUS_STALE_AFTER_MS + 1
    vi.advanceTimersByTime(1_000)

    expect(macosAssertion.stop).toHaveBeenCalledWith('stale-expiry')
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
    const macosAssertion = createMacosAssertion()
    const linuxAssertion = createLinuxAssertion()
    const service = createService(() => 1_000, blocker, macosAssertion, linuxAssertion)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    service.dispose()
    vi.advanceTimersByTime(AGENT_AWAKE_STATUS_STALE_AFTER_MS)

    expect(blocker.stop).toHaveBeenCalledTimes(1)
    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(macosAssertion.dispose).toHaveBeenCalledTimes(1)
    expect(linuxAssertion.dispose).toHaveBeenCalledTimes(1)
  })

  it('reconciles assertions on power resume while work is still eligible', () => {
    const blocker = createBlocker()
    const macosAssertion = createMacosAssertion()
    const linuxAssertion = createLinuxAssertion()
    const monitor = createPowerMonitor()
    const service = createService(() => 1_000, blocker, macosAssertion, linuxAssertion, monitor)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    blocker.startedIds.clear()
    monitor.emitResume()

    expect(blocker.start).toHaveBeenCalledTimes(2)
    expect(macosAssertion.start).toHaveBeenCalledTimes(2)
    expect(linuxAssertion.start).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes the resume listener on dispose', () => {
    const blocker = createBlocker()
    const macosAssertion = createMacosAssertion()
    const linuxAssertion = createLinuxAssertion()
    const monitor = createPowerMonitor()
    const service = createService(() => 1_000, blocker, macosAssertion, linuxAssertion, monitor)

    service.dispose()

    expect(monitor.on).toHaveBeenCalledTimes(1)
    expect(monitor.off).toHaveBeenCalledTimes(1)
  })
})
