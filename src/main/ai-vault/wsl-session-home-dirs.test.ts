import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const wslMocks = vi.hoisted(() => ({
  listWslDistrosAsync: vi.fn(),
  getWslHomeAsync: vi.fn()
}))

vi.mock('../wsl', () => ({
  listWslDistrosAsync: wslMocks.listWslDistrosAsync,
  getWslHomeAsync: wslMocks.getWslHomeAsync
}))

import {
  clearWslSessionHomeDirsCache,
  configureWslSessionHomeDirs,
  isWslSessionScanEnabled,
  listWslSessionHomeDirs,
  listWslSessionHomeDirsCached,
  resetWslSessionHomeDirsForTests
} from './wsl-session-home-dirs'

const UBUNTU_HOME = '\\\\wsl.localhost\\Ubuntu\\home\\ada'

function onWindows(): void {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
}

beforeEach(() => {
  resetWslSessionHomeDirsForTests()
  wslMocks.listWslDistrosAsync.mockReset().mockResolvedValue(['Ubuntu', 'Debian'])
  wslMocks.getWslHomeAsync
    .mockReset()
    .mockImplementation(async (distro: string) => (distro === 'Ubuntu' ? UBUNTU_HOME : null))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('isWslSessionScanEnabled', () => {
  it('is on by default on Windows and always off elsewhere', () => {
    onWindows()
    expect(isWslSessionScanEnabled()).toBe(true)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    expect(isWslSessionScanEnabled()).toBe(false)
  })

  it('follows the configured predicate', () => {
    onWindows()
    configureWslSessionHomeDirs({ isEnabled: () => false })
    expect(isWslSessionScanEnabled()).toBe(false)
    configureWslSessionHomeDirs({})
    expect(isWslSessionScanEnabled()).toBe(true)
  })
})

describe('listWslSessionHomeDirs', () => {
  it('resolves each distro home and drops the ones without one', async () => {
    onWindows()
    await expect(listWslSessionHomeDirs()).resolves.toEqual([UBUNTU_HOME])
    expect(wslMocks.getWslHomeAsync).toHaveBeenCalledTimes(2)
  })

  // The whole point of the opt-out: `wsl.exe -d <distro>` boots the distro, so
  // a disabled scan must never reach the probe.
  it('never spawns wsl.exe when the scan is disabled', async () => {
    onWindows()
    configureWslSessionHomeDirs({ isEnabled: () => false })
    await expect(listWslSessionHomeDirs()).resolves.toEqual([])
    expect(wslMocks.listWslDistrosAsync).not.toHaveBeenCalled()
    expect(wslMocks.getWslHomeAsync).not.toHaveBeenCalled()
  })

  it('never spawns wsl.exe off Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    await expect(listWslSessionHomeDirs()).resolves.toEqual([])
    expect(wslMocks.listWslDistrosAsync).not.toHaveBeenCalled()
  })

  it('re-probes on every call so allowlists never judge a stale distro set', async () => {
    onWindows()
    await listWslSessionHomeDirs()
    await listWslSessionHomeDirs()
    expect(wslMocks.listWslDistrosAsync).toHaveBeenCalledTimes(2)
  })
})

describe('listWslSessionHomeDirsCached', () => {
  it('serves a non-empty answer from cache for five minutes', async () => {
    vi.useFakeTimers()
    onWindows()
    await expect(listWslSessionHomeDirsCached()).resolves.toEqual([UBUNTU_HOME])
    vi.advanceTimersByTime(5 * 60_000 - 1)
    await listWslSessionHomeDirsCached()
    expect(wslMocks.listWslDistrosAsync).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2)
    await listWslSessionHomeDirsCached()
    expect(wslMocks.listWslDistrosAsync).toHaveBeenCalledTimes(2)
  })

  it('retries an empty answer after thirty seconds', async () => {
    vi.useFakeTimers()
    onWindows()
    wslMocks.getWslHomeAsync.mockResolvedValue(null)
    await expect(listWslSessionHomeDirsCached()).resolves.toEqual([])
    vi.advanceTimersByTime(30_000 - 1)
    await listWslSessionHomeDirsCached()
    expect(wslMocks.listWslDistrosAsync).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2)
    await listWslSessionHomeDirsCached()
    expect(wslMocks.listWslDistrosAsync).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent callers onto one probe', async () => {
    onWindows()
    await Promise.all([listWslSessionHomeDirsCached(), listWslSessionHomeDirsCached()])
    expect(wslMocks.listWslDistrosAsync).toHaveBeenCalledTimes(1)
  })

  it('does not share its cache with the uncached lister', async () => {
    onWindows()
    await listWslSessionHomeDirsCached()
    await listWslSessionHomeDirs()
    expect(wslMocks.listWslDistrosAsync).toHaveBeenCalledTimes(2)
  })

  // A settings flip must take effect on the next poll tick, not after the TTL.
  it('drops the cache on clear so a disable is honored immediately', async () => {
    onWindows()
    await expect(listWslSessionHomeDirsCached()).resolves.toEqual([UBUNTU_HOME])
    configureWslSessionHomeDirs({ isEnabled: () => false })
    await expect(listWslSessionHomeDirsCached()).resolves.toEqual([UBUNTU_HOME])
    clearWslSessionHomeDirsCache()
    await expect(listWslSessionHomeDirsCached()).resolves.toEqual([])
    expect(wslMocks.listWslDistrosAsync).toHaveBeenCalledTimes(1)
  })

  // The probe spawns wsl.exe and takes seconds; a flip landing mid-probe must
  // not be undone when that probe finally resolves.
  it('does not let a probe that started before clear repopulate the cache', async () => {
    onWindows()
    let resolveDistros: (distros: string[]) => void = () => {}
    wslMocks.listWslDistrosAsync.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolveDistros = resolve
      })
    )
    const inFlight = listWslSessionHomeDirsCached()
    configureWslSessionHomeDirs({ isEnabled: () => false })
    clearWslSessionHomeDirsCache()
    resolveDistros(['Ubuntu'])
    // The caller that started before the flip still gets its own answer.
    await expect(inFlight).resolves.toEqual([UBUNTU_HOME])
    // The next tick sees the disabled state, not the stale write-back.
    await expect(listWslSessionHomeDirsCached()).resolves.toEqual([])
    expect(wslMocks.listWslDistrosAsync).toHaveBeenCalledTimes(1)
  })
})
