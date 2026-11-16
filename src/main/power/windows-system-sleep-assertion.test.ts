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
  it('holds only a system-sleep assertion while on, and releases it when off', () => {
    const windowsBlocker = createBlocker()
    const { service, displayBlocker } = createService(windowsBlocker)

    service.setMode('on')
    expect([...windowsBlocker.started.values()]).toEqual(['prevent-app-suspension'])
    expect(displayBlocker.started.size).toBe(0)
    expect(service.getStatus()).toEqual({ mode: 'on', active: true })

    service.setMode('off')
    expect(windowsBlocker.started.size).toBe(0)
    expect(displayBlocker.started.size).toBe(0)
    service.dispose()
  })

  it('falls back to the display blocker when the system assertion cannot start', () => {
    const windowsBlocker = createBlocker()
    windowsBlocker.start.mockImplementation(() => {
      throw new Error('denied')
    })
    const { service, displayBlocker } = createService(windowsBlocker)

    service.setMode('on')
    expect([...displayBlocker.started.values()]).toEqual(['prevent-display-sleep'])
    service.dispose()
  })
})
