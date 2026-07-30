import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastAwakeService,
  BROWSER_SCREENCAST_AWAKE_TOKEN_STALE_AFTER_MS
} from './browser-screencast-awake-service'

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
    isStarted: vi.fn((id: number) => startedIds.has(id)),
    startedIds
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
  macosAssertion = createPlatformAssertion(),
  linuxAssertion = createPlatformAssertion(),
  powerMonitor: ReturnType<typeof createPowerMonitor> | null = null,
  getLiveTokens?: () => Iterable<string>
): BrowserScreencastAwakeService {
  return new BrowserScreencastAwakeService({
    blocker,
    getLiveTokens,
    linuxAssertion,
    macosAssertion,
    now,
    powerMonitor,
    logger: {
      debug: vi.fn(),
      warn: vi.fn()
    }
  })
}

describe('BrowserScreencastAwakeService', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it('does not start until a screencast token is acquired', () => {
    const blocker = createBlocker()
    createService(() => 1_000, blocker)

    expect(blocker.start).not.toHaveBeenCalled()
  })

  it('starts Electron and platform assertions on the first acquire', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const linuxAssertion = createPlatformAssertion()
    const service = createService(() => 1_000, blocker, macosAssertion, linuxAssertion)

    service.acquire('stream-1')

    expect(blocker.start).toHaveBeenCalledTimes(1)
    expect(blocker.start).toHaveBeenCalledWith('prevent-display-sleep')
    expect(macosAssertion.start).toHaveBeenCalledTimes(1)
    expect(linuxAssertion.start).toHaveBeenCalledTimes(1)
    expect(service.getActiveCount()).toBe(1)
  })

  it('keeps one blocker across overlapping acquires and releases on the last token', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const linuxAssertion = createPlatformAssertion()
    const service = createService(() => 1_000, blocker, macosAssertion, linuxAssertion)

    service.acquire('stream-1')
    service.acquire('stream-2')
    service.release('stream-1')

    expect(blocker.start).toHaveBeenCalledTimes(1)
    expect(blocker.stop).not.toHaveBeenCalled()
    expect(service.getActiveCount()).toBe(1)

    service.release('stream-2')

    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(macosAssertion.stop).toHaveBeenCalled()
    expect(linuxAssertion.stop).toHaveBeenCalled()
    expect(service.getActiveCount()).toBe(0)
  })

  it('ignores empty acquire and unknown release', () => {
    const blocker = createBlocker()
    const service = createService(() => 1_000, blocker)

    service.acquire('stream-1')
    service.acquire('')
    service.release('missing')

    expect(blocker.start).toHaveBeenCalledTimes(1)
    expect(blocker.stop).not.toHaveBeenCalled()
    expect(service.getActiveCount()).toBe(1)
  })

  it('restarts the blocker after power resume while streams are active', () => {
    const blocker = createBlocker()
    const powerMonitor = createPowerMonitor()
    const service = createService(
      () => 1_000,
      blocker,
      createPlatformAssertion(),
      createPlatformAssertion(),
      powerMonitor
    )

    service.acquire('stream-1')
    blocker.startedIds.clear()
    expect(blocker.isStarted(1)).toBe(false)

    powerMonitor.emitResume()

    expect(blocker.start).toHaveBeenCalledTimes(2)
    expect(blocker.start).toHaveBeenLastCalledWith('prevent-display-sleep')
  })

  it('stops the blocker after the agent-awake stale window without a live-token renew', () => {
    vi.useFakeTimers()
    const blocker = createBlocker()
    let now = 1_000
    const service = createService(() => now, blocker)

    service.acquire('stream-1')
    expect(blocker.start).toHaveBeenCalledTimes(1)

    now = 1_000 + BROWSER_SCREENCAST_AWAKE_TOKEN_STALE_AFTER_MS + 1
    vi.advanceTimersByTime(BROWSER_SCREENCAST_AWAKE_TOKEN_STALE_AFTER_MS + 1)

    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(service.getActiveCount()).toBe(0)
  })

  it('renews live tokens from the authoritative source so long sessions stay awake', () => {
    vi.useFakeTimers()
    const blocker = createBlocker()
    let now = 1_000
    const live = new Set<string>(['stream-1'])
    const service = createService(
      () => now,
      blocker,
      createPlatformAssertion(),
      createPlatformAssertion(),
      null,
      () => live
    )

    service.acquire('stream-1')
    now = 1_000 + BROWSER_SCREENCAST_AWAKE_TOKEN_STALE_AFTER_MS + 1
    vi.advanceTimersByTime(BROWSER_SCREENCAST_AWAKE_TOKEN_STALE_AFTER_MS + 1)

    expect(blocker.stop).not.toHaveBeenCalled()
    expect(service.getActiveCount()).toBe(1)
  })

  it('drops leaked tokens that the live source no longer reports', () => {
    const blocker = createBlocker()
    const live = new Set<string>(['stream-1'])
    const service = createService(
      () => 1_000,
      blocker,
      createPlatformAssertion(),
      createPlatformAssertion(),
      null,
      () => live
    )

    service.acquire('stream-1')
    live.delete('stream-1')
    service.setLiveTokenSource(() => live)

    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(service.getActiveCount()).toBe(0)
  })

  it('dispose clears tokens and stops assertions', () => {
    const blocker = createBlocker()
    const macosAssertion = createPlatformAssertion()
    const linuxAssertion = createPlatformAssertion()
    const service = createService(() => 1_000, blocker, macosAssertion, linuxAssertion)

    service.acquire('stream-1')
    service.dispose()

    expect(blocker.stop).toHaveBeenCalledWith(1)
    expect(macosAssertion.dispose).toHaveBeenCalledTimes(1)
    expect(linuxAssertion.dispose).toHaveBeenCalledTimes(1)
    expect(service.getActiveCount()).toBe(0)
  })
})
