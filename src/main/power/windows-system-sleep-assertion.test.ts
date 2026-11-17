import { describe, expect, it, vi } from 'vitest'
import { AgentAwakeService } from './agent-awake-service'
import { WindowsSystemSleepAssertion } from './windows-system-sleep-assertion'

function createBlocker() {
  let nextId = 1
  const started = new Map<number, string>()
  return {
    started,
    start: vi.fn((type: string) => {
      const id = nextId++
      started.set(id, type)
      return id
    }),
    stop: vi.fn((id: number) => {
      started.delete(id)
    }),
    isStarted: vi.fn((id: number) => started.has(id))
  }
}

const inertAssertion = () => ({ start: vi.fn(() => false), stop: vi.fn(), dispose: vi.fn() })
const logger = { debug: vi.fn(), warn: vi.fn() }

function createService(windowsBlocker: ReturnType<typeof createBlocker>) {
  const displayBlocker = createBlocker()
  const service = new AgentAwakeService({
    blocker: displayBlocker,
    linuxAssertion: inertAssertion(),
    macosAssertion: inertAssertion(),
    windowsAssertion: new WindowsSystemSleepAssertion({
      blocker: windowsBlocker,
      logger,
      platform: 'win32'
    }),
    logger,
    platform: 'win32',
    powerMonitor: null
  })
  return { service, displayBlocker }
}

describe('Windows system sleep assertion in AgentAwakeService', () => {
  it('holds the system assertion and the display blocker while on, and releases both when off', () => {
    const windowsBlocker = createBlocker()
    const { service, displayBlocker } = createService(windowsBlocker)

    service.setMode('on')
    expect([...windowsBlocker.started.values()]).toEqual(['prevent-app-suspension'])
    expect([...displayBlocker.started.values()]).toEqual(['prevent-display-sleep'])
    expect(service.isSleepPrevented()).toBe(true)

    service.setMode('off')
    expect(windowsBlocker.started.size).toBe(0)
    expect(displayBlocker.started.size).toBe(0)
    expect(service.isSleepPrevented()).toBe(false)
    service.dispose()
  })

  it('reports sleep as not prevented when no blocker could start', () => {
    const windowsBlocker = createBlocker()
    windowsBlocker.start.mockImplementation(() => {
      throw new Error('denied')
    })
    const { service, displayBlocker } = createService(windowsBlocker)
    displayBlocker.start.mockImplementation(() => {
      throw new Error('denied')
    })

    service.setMode('on')
    expect(service.getStatus()).toEqual({ mode: 'on', active: true })
    expect(service.isSleepPrevented()).toBe(false)
    service.dispose()
  })
})
