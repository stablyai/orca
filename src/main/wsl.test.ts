import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as childProcess from 'node:child_process'

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn()
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return {
    ...actual,
    execFile: execFileMock,
    execFileSync: execFileSyncMock
  }
})

import {
  _resetWslCachesForTests,
  _setWslCachesForTests,
  getCachedWslAvailability,
  getCachedWslDistros,
  hasCachedWslAvailability,
  hasCachedWslDistros,
  isWslAvailable,
  listWslDistros,
  listWslDistrosAsync,
  parseWslPath,
  toLinuxPath,
  toWindowsWslPath,
  wslUncDirectoryExists,
  wslUncFileExists
} from './wsl'

function withPlatform<T>(value: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

async function withPlatformAsync<T>(value: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('WSL distro discovery cache', () => {
  afterEach(() => {
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    _resetWslCachesForTests()
  })

  it('retries asynchronous discovery after a transient wsl.exe failure', async () => {
    vi.useFakeTimers()
    execFileMock
      .mockImplementationOnce((_command, _args, _options, callback) => {
        callback(new Error('transient failure'), '')
      })
      .mockImplementationOnce((_command, _args, _options, callback) => {
        callback(null, 'Ubuntu\n')
      })

    try {
      await withPlatformAsync('win32', async () => {
        await expect(listWslDistrosAsync()).resolves.toEqual([])
        expect(getCachedWslDistros()).toBeNull()
        // Brief negative caching bounds the wsl.exe spawn rate between retries.
        await expect(listWslDistrosAsync()).resolves.toEqual([])
        expect(execFileMock).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(15_000)
        await expect(listWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries synchronous discovery after a transient wsl.exe failure', () => {
    vi.useFakeTimers()
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('transient failure')
    })
    execFileSyncMock.mockReturnValueOnce('Ubuntu\n')

    try {
      withPlatform('win32', () => {
        expect(listWslDistros()).toEqual([])
        expect(getCachedWslDistros()).toBeNull()
        expect(listWslDistros()).toEqual([])
        expect(execFileSyncMock).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual(['Ubuntu'])
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: `wsl --install` succeeds and reports zero distros while the distro is
  // still being provisioned (or until the required reboot). Caching that empty
  // success for the process lifetime is why users saw WSL offered during setup
  // and then permanently absent from the terminal picker.
  it('retries asynchronous discovery after wsl.exe reports no distros yet', async () => {
    vi.useFakeTimers()
    execFileMock
      .mockImplementationOnce((_command, _args, _options, callback) => {
        callback(null, '')
      })
      .mockImplementationOnce((_command, _args, _options, callback) => {
        callback(null, 'Ubuntu\n')
      })

    try {
      await withPlatformAsync('win32', async () => {
        await expect(listWslDistrosAsync()).resolves.toEqual([])
        vi.advanceTimersByTime(15_000)
        await expect(listWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries synchronous discovery after wsl.exe reports no distros yet', () => {
    vi.useFakeTimers()
    execFileSyncMock.mockReturnValueOnce('')
    execFileSyncMock.mockReturnValueOnce('Ubuntu\n')

    try {
      withPlatform('win32', () => {
        expect(listWslDistros()).toEqual([])
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual(['Ubuntu'])
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: an empty result must still not let every caller re-spawn a blocking
  // wsl.exe; it reuses the same brief negative-cache window as a hard failure.
  it('bounds the wsl.exe spawn rate while no distros are installed', () => {
    execFileSyncMock.mockReturnValue('')

    withPlatform('win32', () => {
      expect(listWslDistros()).toEqual([])
      expect(listWslDistros()).toEqual([])
      expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    })
  })

  it('bounds the asynchronous spawn rate while no distros are installed', async () => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, '')
    })

    await withPlatformAsync('win32', async () => {
      await expect(listWslDistrosAsync()).resolves.toEqual([])
      await expect(listWslDistrosAsync()).resolves.toEqual([])
      expect(execFileMock).toHaveBeenCalledTimes(1)
    })
  })

  it('still caches a non-empty distro list for the process lifetime', () => {
    execFileSyncMock.mockReturnValueOnce('Ubuntu\n')

    withPlatform('win32', () => {
      expect(listWslDistros()).toEqual(['Ubuntu'])
      expect(listWslDistros()).toEqual(['Ubuntu'])
      expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    })
  })

  // Why: docker-desktop entries filter to zero user distros, which is the same
  // "nothing installed yet" state as an empty list — a distro installed later
  // must still appear. The answer stays readable as [] so a missing distro is
  // still visible to `isKnownMissingDistro`.
  it('re-probes a docker-desktop-only machine once a user distro can appear', () => {
    vi.useFakeTimers()
    execFileSyncMock.mockReturnValueOnce('docker-desktop\ndocker-desktop-data\n')
    execFileSyncMock.mockReturnValueOnce('docker-desktop\nUbuntu\n')

    try {
      withPlatform('win32', () => {
        expect(listWslDistros()).toEqual([])
        expect(getCachedWslDistros()).toEqual([])
        expect(listWslDistros()).toEqual([])
        expect(execFileSyncMock).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual(['Ubuntu'])
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: a docker-desktop-only machine filters to empty on every probe, so a flat
  // window would re-spawn wsl.exe every 15s for the whole session.
  it('backs off while the list keeps coming back empty', () => {
    vi.useFakeTimers()
    execFileSyncMock.mockReturnValue('')

    try {
      withPlatform('win32', () => {
        expect(listWslDistros()).toEqual([])
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual([])
        expect(execFileSyncMock).toHaveBeenCalledTimes(2)
        // Second empty result doubles the window, so 15s more is not enough.
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual([])
        expect(execFileSyncMock).toHaveBeenCalledTimes(2)
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual([])
        expect(execFileSyncMock).toHaveBeenCalledTimes(3)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off after repeated distro-list failures', () => {
    vi.useFakeTimers()
    execFileSyncMock.mockImplementation(() => {
      throw new Error('transient failure')
    })

    try {
      withPlatform('win32', () => {
        expect(listWslDistros()).toEqual([])
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual([])
        expect(execFileSyncMock).toHaveBeenCalledTimes(2)
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual([])
        expect(execFileSyncMock).toHaveBeenCalledTimes(2)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: listWslDistrosAsync has no in-flight dedupe, so two probes can resolve out of order.
  // The late empty answer must not erase the list the newer probe already found.
  it('does not let a late empty probe erase a list a newer probe found', async () => {
    const callbacks: ((error: Error | null, stdout: string) => void)[] = []
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callbacks.push(callback)
    })

    await withPlatformAsync('win32', async () => {
      const stale = listWslDistrosAsync()
      const fresh = listWslDistrosAsync()
      expect(callbacks).toHaveLength(2)

      callbacks[1](null, 'Ubuntu\n')
      callbacks[0](null, '')

      await expect(fresh).resolves.toEqual(['Ubuntu'])
      await expect(stale).resolves.toEqual(['Ubuntu'])
      expect(getCachedWslDistros()).toEqual(['Ubuntu'])
    })
  })

  it('does not let an older non-empty probe overwrite a newer list', async () => {
    const callbacks: ((error: Error | null, stdout: string) => void)[] = []
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callbacks.push(callback)
    })

    await withPlatformAsync('win32', async () => {
      const stale = listWslDistrosAsync()
      const fresh = listWslDistrosAsync()
      callbacks[1](null, 'Ubuntu\n')
      callbacks[0](null, 'Debian\n')

      await expect(fresh).resolves.toEqual(['Ubuntu'])
      await expect(stale).resolves.toEqual(['Ubuntu'])
      expect(getCachedWslDistros()).toEqual(['Ubuntu'])
    })
  })

  // Why: N startup callers each land with the same empty answer; counting each one
  // would arm the 5min cap on the first round and hide a distro for that whole time.
  it('counts one empty result per window when probes overlap', async () => {
    vi.useFakeTimers()
    const callbacks: ((error: Error | null, stdout: string) => void)[] = []
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callbacks.push(callback)
    })

    try {
      await withPlatformAsync('win32', async () => {
        const pending = [listWslDistrosAsync(), listWslDistrosAsync(), listWslDistrosAsync()]
        expect(callbacks).toHaveLength(3)
        for (const callback of callbacks) {
          callback(null, '')
        }
        await Promise.all(pending)

        // One window elapsed, not three doublings, so the next probe runs at 15s.
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual([])
        expect(execFileSyncMock).toHaveBeenCalledTimes(1)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: an overlapping failure and empty result must count as one retry window.
  it('holds the base window when a failure and an empty result overlap', async () => {
    vi.useFakeTimers()
    const callbacks: ((error: Error | null, stdout: string) => void)[] = []
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callbacks.push(callback)
    })

    try {
      await withPlatformAsync('win32', async () => {
        const failing = listWslDistrosAsync()
        const empty = listWslDistrosAsync()
        expect(callbacks).toHaveLength(2)
        callbacks[0](new Error('transient failure'), '')
        callbacks[1](null, '')
        await Promise.all([failing, empty])

        vi.advanceTimersByTime(7_500)
        expect(listWslDistros()).toEqual([])
        expect(execFileSyncMock).not.toHaveBeenCalled()
        vi.advanceTimersByTime(7_500)
        expect(listWslDistros()).toEqual([])
        expect(execFileSyncMock).toHaveBeenCalledTimes(1)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not shorten an empty-list backoff when an overlapping probe fails', async () => {
    vi.useFakeTimers()
    execFileSyncMock.mockReturnValueOnce('')
    const callbacks: ((error: Error | null, stdout: string) => void)[] = []
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callbacks.push(callback)
    })

    try {
      await withPlatformAsync('win32', async () => {
        expect(listWslDistros()).toEqual([])
        vi.advanceTimersByTime(15_000)

        const empty = listWslDistrosAsync()
        const failing = listWslDistrosAsync()
        callbacks[0](null, '')
        callbacks[1](new Error('transient failure'), '')
        await Promise.all([empty, failing])

        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual([])
        expect(execFileSyncMock).toHaveBeenCalledTimes(1)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the cap is the only bound on how long a distro installed mid-session stays
  // invisible, so pin it rather than letting the doubling run away.
  it('caps the empty-list backoff at five minutes', () => {
    vi.useFakeTimers()
    execFileSyncMock.mockReturnValue('')

    try {
      withPlatform('win32', () => {
        // Windows double to 15/30/60/120/240s, so the 6th would be 480s uncapped.
        for (const delayMs of [0, 15_000, 30_000, 60_000, 120_000, 240_000]) {
          vi.advanceTimersByTime(delayMs)
          listWslDistros()
        }
        expect(execFileSyncMock).toHaveBeenCalledTimes(6)
        vi.advanceTimersByTime(300_000)
        listWslDistros()
        expect(execFileSyncMock).toHaveBeenCalledTimes(7)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: an empty list is a real probe result and must keep driving the
  // `wsl-distro-missing` repair prompt even once stale. Going null instead fails
  // open and silently spawns `wsl.exe -d <distro>` for a distro Orca saw was absent.
  it('keeps reporting an empty result after it goes stale', () => {
    vi.useFakeTimers()
    execFileSyncMock.mockReturnValue('')

    try {
      withPlatform('win32', () => {
        expect(listWslDistros()).toEqual([])
        expect(getCachedWslDistros()).toEqual([])
        vi.advanceTimersByTime(15_000)
        expect(getCachedWslDistros()).toEqual([])
        expect(hasCachedWslDistros()).toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: a genuinely missing distro yields a non-empty list, which never expires,
  // so repair-required still fires for the case that warrants it.
  it('keeps reporting a known distro list indefinitely', () => {
    vi.useFakeTimers()
    execFileSyncMock.mockReturnValueOnce('Ubuntu\n')

    try {
      withPlatform('win32', () => {
        expect(listWslDistros()).toEqual(['Ubuntu'])
        vi.advanceTimersByTime(600_000)
        expect(getCachedWslDistros()).toEqual(['Ubuntu'])
      })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('WSL availability cache', () => {
  afterEach(() => {
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
    _resetWslCachesForTests()
  })

  // Why: a cold WSL2 utility-VM boot on a just-installed or just-rebooted
  // machine routinely exceeds the 5s probe timeout. Latching false for the
  // process lifetime is what makes WSL vanish from the picker after setup.
  it('retries availability after a probe timeout instead of latching false', () => {
    vi.useFakeTimers()
    execFileSyncMock.mockImplementationOnce(() => {
      // Real execFileSync timeout shape on Windows: status null, signal SIGTERM.
      throw Object.assign(new Error('spawnSync ETIMEDOUT'), {
        code: 'ETIMEDOUT',
        status: null,
        signal: 'SIGTERM'
      })
    })
    execFileSyncMock.mockReturnValueOnce('')

    try {
      withPlatform('win32', () => {
        expect(isWslAvailable()).toBe(false)
        vi.advanceTimersByTime(45_000)
        expect(isWslAvailable()).toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the probe blocks the main process for up to 5s, so a timeout must not
  // let every caller re-spawn it immediately.
  it('bounds the probe rate while the failure window is open', () => {
    execFileSyncMock.mockImplementation(() => {
      // Real execFileSync timeout shape on Windows: status null, signal SIGTERM.
      throw Object.assign(new Error('spawnSync ETIMEDOUT'), {
        code: 'ETIMEDOUT',
        status: null,
        signal: 'SIGTERM'
      })
    })

    withPlatform('win32', () => {
      expect(isWslAvailable()).toBe(false)
      expect(isWslAvailable()).toBe(false)
      expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    })
  })

  it('caches a successful probe for the process lifetime', () => {
    execFileSyncMock.mockReturnValueOnce('')

    withPlatform('win32', () => {
      expect(isWslAvailable()).toBe(true)
      expect(isWslAvailable()).toBe(true)
      expect(execFileSyncMock).toHaveBeenCalledTimes(1)
    })
  })

  // Why: the resolver reads the cached getter, not the probe. Reporting the last
  // observed answer keeps the `wsl-unavailable` repair prompt reachable; going null
  // on staleness would let git and PTY silently resolve to a WSL that just failed.
  it('keeps reporting the last observed answer after it goes stale', () => {
    vi.useFakeTimers()
    execFileSyncMock.mockImplementation(() => {
      // Real execFileSync timeout shape on Windows: status null, signal SIGTERM.
      throw Object.assign(new Error('spawnSync ETIMEDOUT'), {
        code: 'ETIMEDOUT',
        status: null,
        signal: 'SIGTERM'
      })
    })

    try {
      withPlatform('win32', () => {
        expect(isWslAvailable()).toBe(false)
        vi.advanceTimersByTime(45_000)
        expect(getCachedWslAvailability()).toBe(false)
        expect(hasCachedWslAvailability()).toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: an answer-shaped failure earns a long window, not a session-long latch —
  // wsl.exe also exits non-zero while the WSL package is servicing or LxssManager is
  // still starting, which is transient.
  it.each([
    ['wsl.exe reports WSL unusable', { status: 1 }],
    ['wsl.exe is not installed', { code: 'ENOENT' }]
  ])('holds a definitive failure far longer than a timeout when %s', (_label, errorShape) => {
    vi.useFakeTimers()
    execFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('definitive failure'), errorShape)
    })
    execFileSyncMock.mockReturnValueOnce('')

    try {
      withPlatform('win32', () => {
        expect(isWslAvailable()).toBe(false)
        vi.advanceTimersByTime(45_000)
        expect(isWslAvailable()).toBe(false)
        expect(getCachedWslAvailability()).toBe(false)
        expect(execFileSyncMock).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(10 * 60_000)
        expect(isWslAvailable()).toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the probe blocks the main process for up to 5s, so a wedged wsl.exe must not
  // be re-probed on every window boundary for the rest of the session.
  it('backs off after repeated probe failures', () => {
    vi.useFakeTimers()
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('spawnSync ETIMEDOUT'), {
        code: 'ETIMEDOUT',
        status: null,
        signal: 'SIGTERM'
      })
    })

    try {
      withPlatform('win32', () => {
        expect(isWslAvailable()).toBe(false)
        vi.advanceTimersByTime(45_000)
        expect(isWslAvailable()).toBe(false)
        expect(execFileSyncMock).toHaveBeenCalledTimes(2)
        // Second failure doubles the window, so the next boundary is not enough.
        vi.advanceTimersByTime(45_000)
        expect(isWslAvailable()).toBe(false)
        expect(execFileSyncMock).toHaveBeenCalledTimes(2)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: a seeded retryable failure must re-probe once its window lapses, the same
  // as one observed live — otherwise test setup can hide the latch this fixes.
  it('re-probes a seeded retryable failure once its window lapses', () => {
    vi.useFakeTimers()
    execFileSyncMock.mockReturnValueOnce('')

    try {
      withPlatform('win32', () => {
        _setWslCachesForTests({ available: false, availabilityRetryable: true })
        expect(isWslAvailable()).toBe(false)
        vi.advanceTimersByTime(45_000)
        expect(isWslAvailable()).toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the caches expire independently and `getWslRepairReason` checks availability
  // first, so a definitive failure held for 10min would report `wsl-unavailable` over a
  // WSL that just listed a distro. Finding a distro must drop the stale failure.
  it.each([
    ['a definitive failure', { status: 1 }],
    ['a timeout', { code: 'ETIMEDOUT', status: null, signal: 'SIGTERM' }]
  ])('re-probes availability once a distro list succeeds after %s', (_label, errorShape) => {
    vi.useFakeTimers()
    execFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('probe failed'), errorShape)
    })

    try {
      withPlatform('win32', () => {
        expect(isWslAvailable()).toBe(false)

        // A distro turns up (WSL finished provisioning / was repaired mid-session).
        execFileSyncMock.mockReturnValueOnce('Ubuntu\n')
        expect(listWslDistros()).toEqual(['Ubuntu'])

        // Without dropping the stale failure this would stay false for 10min.
        execFileSyncMock.mockReturnValueOnce('')
        expect(isWslAvailable()).toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: an empty list re-probes on a 15s-to-5min schedule, so clearing the availability
  // failure on every empty probe would re-spawn the blocking 5s probe far too often.
  it('does not drop an availability failure for an empty distro list', () => {
    vi.useFakeTimers()
    execFileSyncMock.mockImplementationOnce(() => {
      throw Object.assign(new Error('probe failed'), { status: 1 })
    })

    try {
      withPlatform('win32', () => {
        expect(isWslAvailable()).toBe(false)
        execFileSyncMock.mockReturnValueOnce('')
        expect(listWslDistros()).toEqual([])
        expect(getCachedWslAvailability()).toBe(false)
        // Still inside the definitive window, so no re-probe was paid.
        expect(execFileSyncMock).toHaveBeenCalledTimes(2)
        expect(isWslAvailable()).toBe(false)
        expect(execFileSyncMock).toHaveBeenCalledTimes(2)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps reporting unavailable off Windows without probing', () => {
    withPlatform('darwin', () => {
      expect(isWslAvailable()).toBe(false)
      expect(getCachedWslAvailability()).toBe(false)
      expect(execFileSyncMock).not.toHaveBeenCalled()
    })
  })
})

describe('wsl path helpers', () => {
  it('parses WSL UNC paths on Windows', () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    try {
      expect(parseWslPath('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')).toEqual({
        distro: 'Ubuntu',
        linuxPath: '/home/jin/repo'
      })
    } finally {
      Object.defineProperty(process, 'platform', {
        configurable: true,
        value: originalPlatform
      })
    }
  })

  it('converts Windows drive paths to /mnt paths for WSL commands', () => {
    expect(toLinuxPath('C:\\Users\\jinwo\\git\\orca')).toBe('/mnt/c/Users/jinwo/git/orca')
  })

  it('converts /mnt drive paths back to native Windows form', () => {
    expect(toWindowsWslPath('/mnt/c/Users/jinwo/git/orca', 'Ubuntu')).toBe(
      'C:\\Users\\jinwo\\git\\orca'
    )
  })
})

describe('wslUncDirectoryExists', () => {
  afterEach(() => {
    execFileSyncMock.mockReset()
  })

  it('returns true when the distro reports the directory exists', () => {
    execFileSyncMock.mockReturnValue('')
    const result = withPlatform('win32', () =>
      wslUncDirectoryExists('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')
    )
    expect(result).toBe(true)
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'test', '-d', '/home/jin/repo'],
      expect.objectContaining({ timeout: 5000 })
    )
  })

  it('returns false when test -d exits non-zero (directory missing)', () => {
    execFileSyncMock.mockImplementation(() => {
      // Why: child_process surfaces a non-zero exit as an Error with `status`.
      const error = new Error('Command failed') as Error & { status: number }
      error.status = 1
      throw error
    })
    const result = withPlatform('win32', () =>
      wslUncDirectoryExists('\\\\wsl.localhost\\Ubuntu\\home\\jin\\missing')
    )
    expect(result).toBe(false)
  })

  it('returns null when wsl.exe is unavailable (inconclusive)', () => {
    execFileSyncMock.mockImplementation(() => {
      // No numeric `status` -> spawn failure (ENOENT), not a missing directory.
      const error = new Error('spawn wsl.exe ENOENT') as Error & { code: string }
      error.code = 'ENOENT'
      throw error
    })
    const result = withPlatform('win32', () =>
      wslUncDirectoryExists('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')
    )
    expect(result).toBeNull()
  })

  it('returns null for non-WSL paths and off Windows', () => {
    expect(withPlatform('win32', () => wslUncDirectoryExists('C:\\Users\\jin\\repo'))).toBeNull()
    expect(
      withPlatform('linux', () => wslUncDirectoryExists('\\\\wsl.localhost\\Ubuntu\\home\\jin'))
    ).toBeNull()
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })
})

describe('wslUncFileExists', () => {
  afterEach(() => {
    execFileSyncMock.mockReset()
  })

  it('asks the distro with test -f when the distro reports the file exists', () => {
    execFileSyncMock.mockReturnValue('')
    const result = withPlatform('win32', () =>
      wslUncFileExists('\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude.json')
    )
    expect(result).toBe(true)
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['-d', 'Ubuntu', '--', 'test', '-f', '/home/jin/.claude.json'],
      expect.objectContaining({ timeout: 5000 })
    )
  })

  it('returns false when test -f exits non-zero (file missing)', () => {
    execFileSyncMock.mockImplementation(() => {
      const error = new Error('Command failed') as Error & { status: number }
      error.status = 1
      throw error
    })
    expect(
      withPlatform('win32', () =>
        wslUncFileExists('\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude.json')
      )
    ).toBe(false)
  })

  it('returns null when the distro cannot answer (inconclusive)', () => {
    execFileSyncMock.mockImplementation(() => {
      const error = new Error('spawn wsl.exe ENOENT') as Error & { code: string }
      error.code = 'ENOENT'
      throw error
    })
    expect(
      withPlatform('win32', () =>
        wslUncFileExists('\\\\wsl.localhost\\Ubuntu\\home\\jin\\.claude.json')
      )
    ).toBeNull()
  })
})
