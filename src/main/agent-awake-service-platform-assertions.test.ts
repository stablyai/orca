import { describe, expect, it, vi } from 'vitest'
import { AgentAwakeService } from './agent-awake-service'
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

function workingStatus(): AgentAwakeStatus {
  return {
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

function createService(
  blocker = createBlocker(),
  macosAssertion = createPlatformAssertion(),
  linuxAssertion = createPlatformAssertion()
): AgentAwakeService {
  return new AgentAwakeService({
    blocker,
    linuxAssertion,
    macosAssertion,
    now: () => 1_000,
    powerMonitor: null,
    logger: {
      debug: vi.fn(),
      warn: vi.fn()
    }
  })
}

describe('AgentAwakeService platform assertions', () => {
  it('keeps Electron blocker active when macOS assertion start fails', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const linuxAssertion = createPlatformAssertion()
    macosAssertion.start.mockImplementation(() => {
      throw new Error('caffeinate failed')
    })
    const service = createService(blocker, macosAssertion, linuxAssertion)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    service.setEnabled(false)

    expect(blocker.start).toHaveBeenCalledWith('prevent-display-sleep')
    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(macosAssertion.stop).toHaveBeenCalled()
    expect(linuxAssertion.start).toHaveBeenCalledTimes(1)
    expect(linuxAssertion.stop).toHaveBeenCalled()
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
