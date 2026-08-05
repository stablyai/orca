import { beforeEach, describe, expect, it, vi } from 'vitest'
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

function createPlatformAssertion() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    dispose: vi.fn()
  }
}

function createPowerMonitor() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    on: vi.fn((event: string, listener: () => void) => {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
    }),
    off: vi.fn((event: string, listener: () => void) => {
      listeners.get(event)?.delete(listener)
    }),
    emit(event: string) {
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
  powerMonitor: ReturnType<typeof createPowerMonitor> | null = null,
  wakeDisplay = vi.fn()
): BrowserScreencastAwakeService {
  return new BrowserScreencastAwakeService({
    blocker,
    linuxAssertion,
    macosAssertion,
    powerMonitor,
    wakeDisplay,
    logger: {
      debug: vi.fn(),
      warn: vi.fn()
    }
  })
}

describe('BrowserScreencastAwakeService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not start until a screencast token is acquired', () => {
    const blocker = createBlocker()
    const wakeDisplay = vi.fn()
    createService(blocker, createPlatformAssertion(), createPlatformAssertion(), null, wakeDisplay)

    expect(blocker.start).not.toHaveBeenCalled()
    expect(wakeDisplay).not.toHaveBeenCalled()
  })

  it('wakes the display once when the first screencast becomes active', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const linuxAssertion = createPlatformAssertion()
    const wakeDisplay = vi.fn()
    const service = createService(blocker, macosAssertion, linuxAssertion, null, wakeDisplay)

    service.acquire('stream-1')
    service.acquire('stream-2')

    expect(wakeDisplay).toHaveBeenCalledTimes(1)
    expect(wakeDisplay).toHaveBeenCalledWith('screencast-start')
    expect(blocker.start).toHaveBeenCalledWith('prevent-display-sleep')
    expect(macosAssertion.start).toHaveBeenCalled()
    expect(linuxAssertion.start).toHaveBeenCalled()
    expect(service.getActiveCount()).toBe(2)
  })

  it('stops the blocker only after the last token is released', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const linuxAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion, linuxAssertion)

    service.acquire('stream-1')
    service.acquire('stream-2')
    service.release('stream-1')

    expect(blocker.stop).not.toHaveBeenCalled()

    service.release('stream-2')

    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(macosAssertion.stop).toHaveBeenCalled()
    expect(linuxAssertion.stop).toHaveBeenCalled()
    expect(service.getActiveCount()).toBe(0)
  })

  it('ignores duplicate acquire and unknown release', () => {
    const blocker = createBlocker()
    const wakeDisplay = vi.fn()
    const service = createService(
      blocker,
      createPlatformAssertion(),
      createPlatformAssertion(),
      null,
      wakeDisplay
    )

    service.acquire('stream-1')
    service.acquire('stream-1')
    service.release('missing')

    expect(wakeDisplay).toHaveBeenCalledTimes(1)
    expect(blocker.start).toHaveBeenCalledTimes(1)
    expect(service.getActiveCount()).toBe(1)
  })

  it('restarts the blocker after power resume while tokens remain', () => {
    const blocker = createBlocker()
    const powerMonitor = createPowerMonitor()
    const service = createService(
      blocker,
      createPlatformAssertion(),
      createPlatformAssertion(),
      powerMonitor
    )

    service.acquire('stream-1')
    blocker.isStarted.mockReturnValueOnce(false)
    powerMonitor.emit('resume')

    expect(blocker.start).toHaveBeenCalledTimes(2)
    expect(blocker.start).toHaveBeenLastCalledWith('prevent-display-sleep')
  })

  it('dispose clears tokens and stops assertions', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const linuxAssertion = createPlatformAssertion()
    const service = createService(blocker, macosAssertion, linuxAssertion)

    service.acquire('stream-1')
    service.dispose()

    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(macosAssertion.dispose).toHaveBeenCalled()
    expect(linuxAssertion.dispose).toHaveBeenCalled()
    expect(service.getActiveCount()).toBe(0)
  })
})
