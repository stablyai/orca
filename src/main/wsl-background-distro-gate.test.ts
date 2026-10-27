import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  listRunningWslDistrosAsync:
    vi.fn<(options?: { requireConfirmed?: boolean }) => Promise<string[]>>(),
  listWslDistrosAsync: vi.fn<() => Promise<string[]>>()
}))
vi.mock('./wsl', () => wslMocks)

import {
  _resetWslBackgroundDistroGateForTests,
  deferUntilWslDistroRunning,
  isWslDistroRunning,
  isWslDistroRunningForBackgroundWork,
  noteWslDistroMayHaveStopped,
  noteWslDistrosRunning,
  readSettledConfirmedRunningWslDistros,
  WSL_STOP_SETTLE_MS
} from './wsl-background-distro-gate'
import {
  _resetRunningWslDistroCacheForTests,
  resolveRunningWslDistros
} from './wsl-running-distro-cache'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

beforeEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  wslMocks.listRunningWslDistrosAsync.mockResolvedValue(['Ubuntu'])
  wslMocks.listWslDistrosAsync.mockResolvedValue(['Debian', 'Ubuntu'])
})

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  _resetWslBackgroundDistroGateForTests()
  _resetRunningWslDistroCacheForTests()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('isWslDistroRunning', () => {
  it('matches running distros case-insensitively', async () => {
    await expect(isWslDistroRunning(' ubuntu ')).resolves.toBe(true)
    await expect(isWslDistroRunning('Debian')).resolves.toBe(false)
  })

  it('reads a distro as stopped when the probe fails, not as its last-known state', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let probe: () => Promise<string[]> = async () => ['Ubuntu']
    wslMocks.listRunningWslDistrosAsync.mockImplementation((options) =>
      resolveRunningWslDistros(() => probe(), options)
    )
    await expect(isWslDistroRunning('Ubuntu')).resolves.toBe(true)

    probe = () => Promise.reject(new Error('wsl.exe wedged'))
    await expect(isWslDistroRunning('Ubuntu')).resolves.toBe(false)
    await expect(isWslDistroRunning('Ubuntu')).resolves.toBe(false)
  })
})

describe('the stop settle window', () => {
  it('starts no running read inside the window, even when a timer fires early', async () => {
    // Node timers can wake ~2ms short; firing far earlier makes a single sleep fail every time.
    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, ms, ...args) =>
      realSetTimeout(handler, Math.max(0, (ms ?? 0) - 100), ...args)
    )
    const probeStarts: number[] = []
    wslMocks.listRunningWslDistrosAsync.mockImplementation((options) =>
      resolveRunningWslDistros(async () => {
        probeStarts.push(performance.now())
        return []
      }, options)
    )
    const settledAt = performance.now() + WSL_STOP_SETTLE_MS
    noteWslDistroMayHaveStopped('Ubuntu')

    await expect(isWslDistroRunning('Ubuntu')).resolves.toBe(false)
    expect(probeStarts).toHaveLength(1)
    expect(probeStarts[0]).toBeGreaterThanOrEqual(settledAt)
  })
})

describe('readSettledConfirmedRunningWslDistros', () => {
  it('never answers from a probe that started inside the window, even one still in flight', async () => {
    let finishStale: (distros: string[]) => void = () => {}
    const probe = vi
      .fn<() => Promise<string[]>>()
      .mockImplementationOnce(() => new Promise((resolve) => (finishStale = resolve)))
      .mockResolvedValueOnce([])
    wslMocks.listRunningWslDistrosAsync.mockImplementation((options) =>
      resolveRunningWslDistros(probe, options)
    )
    const stale = isWslDistroRunning('Ubuntu')
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())

    const settled = readSettledConfirmedRunningWslDistros('Ubuntu', performance.now())
    finishStale(['Ubuntu'])

    await expect(stale).resolves.toBe(true)
    await expect(settled).resolves.toEqual({ status: 'confirmed', distros: [] })
    expect(probe).toHaveBeenCalledTimes(2)
  })
})

describe('resolveRunningWslDistros startedAfter', () => {
  it('answers from a confirmed read that started after the anchor, and reads again for a later one', async () => {
    const probe = vi.fn(async () => ['Ubuntu'])
    const anchor = performance.now()
    await resolveRunningWslDistros(probe)
    await expect(resolveRunningWslDistros(probe, { startedAfter: anchor })).resolves.toEqual([
      'Ubuntu'
    ])
    expect(probe).toHaveBeenCalledTimes(1)
    await resolveRunningWslDistros(probe, { startedAfter: performance.now() })
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('never answers an anchored caller from a failed read', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const anchor = performance.now()
    await resolveRunningWslDistros(() => Promise.reject(new Error('wsl.exe wedged')))
    await expect(
      resolveRunningWslDistros(async () => ['Ubuntu'], {
        startedAfter: anchor,
        requireConfirmed: true
      })
    ).rejects.toThrow()
  })
})

describe('deferUntilWslDistroRunning cancel', () => {
  it('drops the task it registered, but not a newer one under the same key', () => {
    const first = vi.fn()
    const second = vi.fn()
    const cancelFirst = deferUntilWslDistroRunning('Ubuntu', 'k', first)
    const cancelSecond = deferUntilWslDistroRunning('Ubuntu', 'k', second)
    cancelFirst()
    noteWslDistrosRunning(['Ubuntu'])
    expect(second).toHaveBeenCalledTimes(1)
    const third = vi.fn()
    deferUntilWslDistroRunning('Ubuntu', 'k', third)
    cancelSecond()
    cancelFirst()
    noteWslDistrosRunning(['Ubuntu'])
    expect(third).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })
})

describe('isWslDistroRunningForBackgroundWork', () => {
  it('checks the default distro when none is named', async () => {
    await expect(isWslDistroRunningForBackgroundWork(null)).resolves.toBe(false)
    wslMocks.listWslDistrosAsync.mockResolvedValue(['Ubuntu'])
    await expect(isWslDistroRunningForBackgroundWork(undefined)).resolves.toBe(true)
  })

  it('treats a host with no distros, or no WSL at all, as not running', async () => {
    wslMocks.listWslDistrosAsync.mockResolvedValue([])
    await expect(isWslDistroRunningForBackgroundWork(null)).resolves.toBe(false)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    await expect(isWslDistroRunningForBackgroundWork('Ubuntu')).resolves.toBe(false)
    expect(wslMocks.listRunningWslDistrosAsync).not.toHaveBeenCalled()
  })
})

describe('deferUntilWslDistroRunning', () => {
  it('runs deferred work once, when its distro is seen running', () => {
    const ubuntuTask = vi.fn()
    const debianTask = vi.fn()
    deferUntilWslDistroRunning('Ubuntu', 'work', ubuntuTask)
    deferUntilWslDistroRunning('Debian', 'work', debianTask)

    noteWslDistrosRunning(['UBUNTU'])
    noteWslDistrosRunning(['Ubuntu'])

    expect(ubuntuTask).toHaveBeenCalledTimes(1)
    expect(debianTask).not.toHaveBeenCalled()
  })

  it('keeps only the latest task per key', () => {
    const first = vi.fn()
    const second = vi.fn()
    deferUntilWslDistroRunning('Ubuntu', 'same', first)
    deferUntilWslDistroRunning('Ubuntu', 'same', second)

    noteWslDistrosRunning(['Ubuntu'])

    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('drains on a confirmed running-distro probe but not on a failed one', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const task = vi.fn()
    deferUntilWslDistroRunning('Ubuntu', 'work', task)

    await resolveRunningWslDistros(() => Promise.reject(new Error('wsl.exe wedged')))
    expect(task).not.toHaveBeenCalled()

    _resetRunningWslDistroCacheForTests()
    await resolveRunningWslDistros(async () => ['Ubuntu'])
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('isolates a failing task from the rest of the drain', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const after = vi.fn()
    deferUntilWslDistroRunning('Ubuntu', 'throws', () => {
      throw new Error('boom')
    })
    deferUntilWslDistroRunning('Ubuntu', 'rejects', () => Promise.reject(new Error('later')))
    deferUntilWslDistroRunning('Ubuntu', 'after', after)

    noteWslDistrosRunning(['Ubuntu'])
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2))

    expect(after).toHaveBeenCalledTimes(1)
  })
})
