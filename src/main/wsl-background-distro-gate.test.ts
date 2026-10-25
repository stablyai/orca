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
  noteWslDistrosRunning
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
