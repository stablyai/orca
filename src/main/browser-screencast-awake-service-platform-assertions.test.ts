import { describe, expect, it, vi } from 'vitest'
import { BrowserScreencastAwakeService } from './browser-screencast-awake-service'

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

describe('BrowserScreencastAwakeService platform assertions', () => {
  it('still starts the Electron blocker when macOS assertion start throws', () => {
    const blocker = createBlocker()
    const macosAssertion = {
      start: vi.fn(() => {
        throw new Error('caffeinate failed')
      }),
      stop: vi.fn(),
      dispose: vi.fn()
    }
    const service = new BrowserScreencastAwakeService({
      blocker,
      linuxAssertion: { start: vi.fn(), stop: vi.fn(), dispose: vi.fn() },
      macosAssertion,
      powerMonitor: null,
      wakeDisplay: vi.fn(),
      logger: { debug: vi.fn(), warn: vi.fn() }
    })

    service.acquire('stream-1')

    expect(blocker.start).toHaveBeenCalledWith('prevent-display-sleep')
  })

  it('still starts platform assertions when the Electron blocker fails', () => {
    const macosAssertion = { start: vi.fn(), stop: vi.fn(), dispose: vi.fn() }
    const linuxAssertion = { start: vi.fn(), stop: vi.fn(), dispose: vi.fn() }
    const service = new BrowserScreencastAwakeService({
      blocker: {
        start: vi.fn(() => {
          throw new Error('blocker failed')
        }),
        stop: vi.fn(),
        isStarted: vi.fn(() => false)
      },
      linuxAssertion,
      macosAssertion,
      powerMonitor: null,
      wakeDisplay: vi.fn(),
      logger: { debug: vi.fn(), warn: vi.fn() }
    })

    service.acquire('stream-1')

    expect(macosAssertion.start).toHaveBeenCalled()
    expect(linuxAssertion.start).toHaveBeenCalled()
  })
})
