import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentAwakeService } from './agent-awake-service'
import type { AgentAwakeStatus } from './agent-awake-status-lease'

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
    paneKey: 'pane-1',
    state: 'working',
    receivedAt: 1_000,
    observedInCurrentRuntime: true
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

const services = new Set<AgentAwakeService>()

afterEach(() => {
  for (const service of services) {
    service.dispose()
  }
  services.clear()
})

function createService(
  blocker = createBlocker(),
  macosAssertion = createPlatformAssertion()
): AgentAwakeService {
  const service = new AgentAwakeService({
    blocker,
    linuxAssertion: createPlatformAssertion(),
    macosAssertion,
    now: () => 1_000,
    platform: 'darwin',
    powerMonitor: null,
    logger: { debug: vi.fn(), warn: vi.fn() }
  })
  services.add(service)
  return service
}

describe('macOS keep-awake display blocking on battery', () => {
  beforeEach(() => {
    isOnBatteryPowerMock.mockReset()
    isOnBatteryPowerMock.mockReturnValue(false)
  })

  it('uses caffeinate without Electron display blocking on macOS AC', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])

    expect(macosAssertion.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).not.toHaveBeenCalled()
  })

  it('starts Electron display blocking on macOS battery while keep-awake is active', () => {
    isOnBatteryPowerMock.mockReturnValue(true)
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])

    expect(macosAssertion.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).toHaveBeenCalledExactlyOnceWith('prevent-display-sleep')
  })

  it('does not start the display blocker on battery while keep-awake is idle', () => {
    isOnBatteryPowerMock.mockReturnValue(true)
    const blocker = createBlocker()
    const service = createService(blocker)

    service.setEnabled(true)

    expect(blocker.start).not.toHaveBeenCalled()
  })

  it('stops the display blocker when keep-awake goes idle on battery', () => {
    isOnBatteryPowerMock.mockReturnValue(true)
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion)

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
    const service = createService(blocker, macosAssertion)

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
    const service = createService(blocker, macosAssertion)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])

    expect(macosAssertion.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).not.toHaveBeenCalled()
  })
})
