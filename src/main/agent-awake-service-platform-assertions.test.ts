import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentAwakeService } from './agent-awake-service'
import type { AgentAwakeStatus } from './agent-awake-service'

const isOnBatteryPowerMock = vi.hoisted(() => vi.fn(() => false))

vi.mock('electron', () => ({
  powerMonitor: {
    on: vi.fn(),
    off: vi.fn(),
    isOnBatteryPower: isOnBatteryPowerMock
  },
  powerSaveBlocker: {
    start: vi.fn(),
    stop: vi.fn(),
    isStarted: vi.fn()
  }
}))

function workingStatus(): AgentAwakeStatus {
  return {
    state: 'working',
    receivedAt: 1_000,
    observedInCurrentRuntime: true
  }
}

describe('AgentAwakeService status array ownership', () => {
  it('does not observe rows appended to the caller array after setStatuses', () => {
    const service = new AgentAwakeService()
    service.setMode('auto')
    const statuses: AgentAwakeStatus[] = [workingStatus()]

    service.setStatuses(statuses)
    const before = service.getWorkingAgentCount()
    statuses.push(workingStatus(), workingStatus())

    expect(service.getWorkingAgentCount()).toBe(before)
  })
})

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
    isStarted: vi.fn((id: number) => startedIds.has(id))
  }
}

function createPlatformAssertion() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn()
  }
}

type PowerMonitorEvent = 'resume' | 'on-battery' | 'on-ac'

function createPowerMonitor() {
  const listeners = new Map<PowerMonitorEvent, Set<() => void>>()
  return {
    on: vi.fn((event: PowerMonitorEvent, listener: () => void) => {
      const eventListeners = listeners.get(event) ?? new Set<() => void>()
      eventListeners.add(listener)
      listeners.set(event, eventListeners)
    }),
    off: vi.fn((event: PowerMonitorEvent, listener: () => void) => {
      listeners.get(event)?.delete(listener)
    }),
    emit: (event: PowerMonitorEvent) => {
      for (const listener of listeners.get(event) ?? []) {
        listener()
      }
    }
  }
}

function createService(
  blocker = createBlocker(),
  macosAssertion = createPlatformAssertion(),
  linuxAssertion = createPlatformAssertion(),
  platform: NodeJS.Platform = 'linux',
  powerMonitor: ReturnType<typeof createPowerMonitor> | null = null
): AgentAwakeService {
  return new AgentAwakeService({
    blocker,
    linuxAssertion,
    macosAssertion,
    now: () => 1_000,
    platform,
    powerMonitor,
    logger: {
      debug: vi.fn(),
      warn: vi.fn()
    }
  })
}

describe('AgentAwakeService platform assertions', () => {
  beforeEach(() => {
    isOnBatteryPowerMock.mockReset()
    isOnBatteryPowerMock.mockReturnValue(false)
  })

  it('uses caffeinate without Electron display blocking on macOS AC', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion, createPlatformAssertion(), 'darwin')

    service.setEnabled(true)
    service.setStatuses([workingStatus()])

    expect(macosAssertion.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).not.toHaveBeenCalled()
  })

  it('starts Electron display blocking on macOS battery while keep-awake is active', () => {
    isOnBatteryPowerMock.mockReturnValue(true)
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion, createPlatformAssertion(), 'darwin')

    service.setEnabled(true)
    service.setStatuses([workingStatus()])

    expect(macosAssertion.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).toHaveBeenCalledWith('prevent-display-sleep')
  })

  it('refreshes the display blocker when macOS changes power source during an active run', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const monitor = createPowerMonitor()
    const service = createService(
      blocker,
      macosAssertion,
      createPlatformAssertion(),
      'darwin',
      monitor
    )

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    isOnBatteryPowerMock.mockReturnValue(true)
    monitor.emit('on-battery')

    expect(blocker.start).toHaveBeenCalledWith('prevent-display-sleep')

    isOnBatteryPowerMock.mockReturnValue(false)
    monitor.emit('on-ac')

    expect(blocker.stop).toHaveBeenCalledWith(1)
  })

  it('does not start the display blocker on battery while keep-awake is idle', () => {
    isOnBatteryPowerMock.mockReturnValue(true)
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion, createPlatformAssertion(), 'darwin')

    service.setEnabled(true)

    expect(macosAssertion.start).not.toHaveBeenCalled()
    expect(blocker.start).not.toHaveBeenCalled()
  })

  it('stops the display blocker when keep-awake goes idle on battery', () => {
    isOnBatteryPowerMock.mockReturnValue(true)
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion, createPlatformAssertion(), 'darwin')

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    service.setStatuses([])

    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(macosAssertion.stop).toHaveBeenCalledWith('status-change')
  })

  it('drops the display blocker when macOS returns to AC while still blocking', () => {
    isOnBatteryPowerMock.mockReturnValue(true)
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion, createPlatformAssertion(), 'darwin')

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    macosAssertion.stop.mockClear()
    isOnBatteryPowerMock.mockReturnValue(false)
    service.setStatuses([{ ...workingStatus(), receivedAt: 1_001 }])

    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(macosAssertion.stop).not.toHaveBeenCalled()
  })

  it('treats an unavailable battery API as AC on macOS', () => {
    isOnBatteryPowerMock.mockImplementation(() => {
      throw new Error('unsupported')
    })
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion, createPlatformAssertion(), 'darwin')

    service.setEnabled(true)
    service.setStatuses([workingStatus()])

    expect(macosAssertion.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).not.toHaveBeenCalled()
  })

  it('removes macOS power-source listeners on dispose', () => {
    const monitor = createPowerMonitor()
    const service = createService(
      createBlocker(),
      createPlatformAssertion(),
      createPlatformAssertion(),
      'darwin',
      monitor
    )

    service.dispose()

    expect(monitor.on).toHaveBeenCalledWith('on-battery', expect.any(Function))
    expect(monitor.on).toHaveBeenCalledWith('on-ac', expect.any(Function))
    expect(monitor.off).toHaveBeenCalledWith('on-battery', expect.any(Function))
    expect(monitor.off).toHaveBeenCalledWith('on-ac', expect.any(Function))
  })

  it('keeps Electron blocker active when macOS assertion start fails', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const linuxAssertion = createPlatformAssertion()
    macosAssertion.start.mockImplementation(() => {
      throw new Error('caffeinate failed')
    })
    const service = createService(blocker, macosAssertion, linuxAssertion, 'darwin')

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    service.setEnabled(false)

    expect(blocker.start).toHaveBeenCalledWith('prevent-display-sleep')
    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(macosAssertion.stop).toHaveBeenCalled()
    expect(linuxAssertion.start).toHaveBeenCalledTimes(1)
    expect(linuxAssertion.stop).toHaveBeenCalled()
  })

  it('drops the display-blocking fallback after caffeinate recovers', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    macosAssertion.start.mockImplementationOnce(() => false).mockImplementation(() => true)
    const service = createService(blocker, macosAssertion, createPlatformAssertion(), 'darwin')

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    expect(blocker.start).toHaveBeenCalledWith('prevent-display-sleep')

    service.setStatuses([{ ...workingStatus(), receivedAt: 1_001 }])
    expect(blocker.stop).toHaveBeenCalledWith(1)
  })

  it('keeps Electron blocker active when Linux assertion start fails', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const linuxAssertion = createPlatformAssertion()
    linuxAssertion.start.mockImplementation(() => {
      throw new Error('systemd-inhibit failed')
    })
    const service = createService(blocker, macosAssertion, linuxAssertion)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    service.setEnabled(false)

    expect(blocker.start).toHaveBeenCalledWith('prevent-display-sleep')
    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(macosAssertion.start).toHaveBeenCalledTimes(1)
    expect(macosAssertion.stop).toHaveBeenCalled()
    expect(linuxAssertion.stop).toHaveBeenCalled()
  })

  it('starts platform assertions when Electron blocker start fails', () => {
    const blocker = createBlocker()
    blocker.start.mockImplementation(() => {
      throw new Error('electron failed')
    })
    const macosAssertion = createPlatformAssertion()
    const linuxAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion, linuxAssertion)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    service.setEnabled(false)

    expect(macosAssertion.start).toHaveBeenCalledTimes(1)
    expect(macosAssertion.stop).toHaveBeenCalled()
    expect(linuxAssertion.start).toHaveBeenCalledTimes(1)
    expect(linuxAssertion.stop).toHaveBeenCalled()
    expect(blocker.stop).not.toHaveBeenCalled()
  })
})
