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
    paneKey: 'pane-1',
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
    dispose: vi.fn(),
    setKeepDisplayAwake: vi.fn()
  }
}

function createService(
  blocker = createBlocker(),
  macosAssertion = createPlatformAssertion(),
  linuxAssertion = createPlatformAssertion(),
  platform: NodeJS.Platform = 'linux'
): AgentAwakeService {
  return new AgentAwakeService({
    blocker,
    linuxAssertion,
    macosAssertion,
    now: () => 1_000,
    platform,
    powerMonitor: null,
    logger: {
      debug: vi.fn(),
      warn: vi.fn()
    }
  })
}

describe('AgentAwakeService platform assertions', () => {
  it('uses caffeinate without Electron display blocking on macOS', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion, createPlatformAssertion(), 'darwin')

    service.setEnabled(true)
    service.setStatuses([workingStatus()])

    expect(macosAssertion.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).not.toHaveBeenCalled()
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

    // The fallback honors keepDisplayAwake (unset): caffeinate owns display sleep on macOS.
    expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension')
    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(macosAssertion.stop).toHaveBeenCalled()
    expect(linuxAssertion.start).toHaveBeenCalledTimes(1)
    expect(linuxAssertion.stop).toHaveBeenCalled()
  })

  it('restarts a live macOS fallback blocker with the display type on toggle', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    macosAssertion.start.mockImplementation(() => {
      throw new Error('caffeinate failed')
    })
    macosAssertion.dispose = vi.fn()
    const service = createService(blocker, macosAssertion, createPlatformAssertion(), 'darwin')

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    expect(blocker.start).toHaveBeenLastCalledWith('prevent-app-suspension')

    service.setKeepDisplayAwake(true)

    expect(macosAssertion.setKeepDisplayAwake).toHaveBeenCalledWith(true)
    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(blocker.start).toHaveBeenLastCalledWith('prevent-display-sleep')
  })

  it('drops the display-blocking fallback after caffeinate recovers', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    macosAssertion.start.mockImplementationOnce(() => false).mockImplementation(() => true)
    const service = createService(blocker, macosAssertion, createPlatformAssertion(), 'darwin')

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    expect(blocker.start).toHaveBeenCalledWith('prevent-app-suspension')

    service.setKeepDisplayAwake(true)
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

  it('leaves the Electron blocker on prevent-display-sleep whatever the display preference is', () => {
    const blocker = createBlocker()
    const service = createService(blocker)

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    expect(blocker.start).toHaveBeenLastCalledWith('prevent-display-sleep')

    // Off macOS this path already keeps the display awake; the setting must not take that away.
    service.setKeepDisplayAwake(true)
    service.setKeepDisplayAwake(false)

    expect(blocker.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).toHaveBeenLastCalledWith('prevent-display-sleep')
    expect(blocker.stop).not.toHaveBeenCalled()
  })

  it('restarts the live macOS caffeinate assertion and forwards the flag on toggle', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion, createPlatformAssertion(), 'darwin')

    service.setEnabled(true)
    service.setStatuses([workingStatus()])
    expect(macosAssertion.start).toHaveBeenCalledTimes(1)

    service.setKeepDisplayAwake(true)

    expect(macosAssertion.setKeepDisplayAwake).toHaveBeenCalledWith(true)
    expect(macosAssertion.stop).toHaveBeenCalledWith('display-preference-change')
    expect(macosAssertion.start).toHaveBeenCalledTimes(2)
    expect(blocker.start).not.toHaveBeenCalled()
  })

  it('only stores the display preference while sleep prevention is inactive', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion, createPlatformAssertion(), 'darwin')

    service.setKeepDisplayAwake(true)

    expect(macosAssertion.setKeepDisplayAwake).toHaveBeenCalledWith(true)
    expect(macosAssertion.start).not.toHaveBeenCalled()
    expect(macosAssertion.stop).not.toHaveBeenCalled()
    expect(blocker.start).not.toHaveBeenCalled()

    service.setKeepDisplayAwake(true)
    expect(macosAssertion.setKeepDisplayAwake).toHaveBeenCalledTimes(1)
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
