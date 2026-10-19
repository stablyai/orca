import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const { runProcessMock, runProcessSyncMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  runProcessSyncMock: vi.fn()
}))

vi.mock('@orca/process-host', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))
vi.mock('./wsl-interop-spawn-directory', () => ({
  resolveWslInteropSpawnCwd: () => 'C:\\Windows'
}))

function exited(stdout: string, code: number | null = 0): ProcessResult {
  return { code, signal: null, stdout, stderr: '', timedOut: false }
}

const TIMED_OUT: ProcessResult = {
  code: null,
  signal: 'SIGTERM',
  stdout: '',
  stderr: '',
  timedOut: true
}

function spawnError(code: string): Error {
  return Object.assign(new Error(`spawn wsl.exe ${code}`), { code })
}

import {
  _resetWslCachesForTests,
  _setWslCachesForTests,
  getCachedWslAvailability,
  getCachedWslDistros,
  getWslHome,
  hasCachedWslAvailability,
  hasCachedWslDistros,
  isWslAvailableAsync,
  listWslDistros,
  listWslDistrosAsync,
  parseWslPath,
  toLinuxPath,
  toWindowsWslPath,
  wslUncDirectoryExistsAsync
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
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
    _resetWslCachesForTests()
  })

  it('retries asynchronous discovery after a transient wsl.exe failure', async () => {
    vi.useFakeTimers()
    runProcessMock.mockResolvedValueOnce(TIMED_OUT).mockResolvedValueOnce(exited('Ubuntu\n'))

    try {
      await withPlatformAsync('win32', async () => {
        await expect(listWslDistrosAsync()).resolves.toEqual([])
        expect(getCachedWslDistros()).toBeNull()
        // Brief negative caching bounds the wsl.exe spawn rate between retries.
        await expect(listWslDistrosAsync()).resolves.toEqual([])
        expect(runProcessMock).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(15_000)
        await expect(listWslDistrosAsync()).resolves.toEqual(['Ubuntu'])
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries synchronous discovery after a transient wsl.exe failure', () => {
    vi.useFakeTimers()
    runProcessSyncMock.mockReturnValueOnce(TIMED_OUT)
    runProcessSyncMock.mockReturnValueOnce(exited('Ubuntu\n'))

    try {
      withPlatform('win32', () => {
        expect(listWslDistros()).toEqual([])
        expect(getCachedWslDistros()).toBeNull()
        expect(listWslDistros()).toEqual([])
        expect(runProcessSyncMock).toHaveBeenCalledTimes(1)
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
    runProcessMock.mockResolvedValueOnce(exited('')).mockResolvedValueOnce(exited('Ubuntu\n'))

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
    runProcessSyncMock.mockReturnValueOnce(exited(''))
    runProcessSyncMock.mockReturnValueOnce(exited('Ubuntu\n'))

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
    runProcessSyncMock.mockReturnValue(exited(''))

    withPlatform('win32', () => {
      expect(listWslDistros()).toEqual([])
      expect(listWslDistros()).toEqual([])
      expect(runProcessSyncMock).toHaveBeenCalledTimes(1)
    })
  })

  it('bounds the asynchronous spawn rate while no distros are installed', async () => {
    runProcessMock.mockResolvedValue(exited(''))

    await withPlatformAsync('win32', async () => {
      await expect(listWslDistrosAsync()).resolves.toEqual([])
      await expect(listWslDistrosAsync()).resolves.toEqual([])
      expect(runProcessMock).toHaveBeenCalledTimes(1)
    })
  })

  it('still caches a non-empty distro list for the process lifetime', () => {
    runProcessSyncMock.mockReturnValueOnce(exited('Ubuntu\n'))

    withPlatform('win32', () => {
      expect(listWslDistros()).toEqual(['Ubuntu'])
      expect(listWslDistros()).toEqual(['Ubuntu'])
      expect(runProcessSyncMock).toHaveBeenCalledTimes(1)
    })
  })

  // Why: docker-desktop entries filter to zero user distros, which is the same
  // "nothing installed yet" state as an empty list — a distro installed later
  // must still appear. The answer stays readable as [] so a missing distro is
  // still visible to `isKnownMissingDistro`.
  it('re-probes a docker-desktop-only machine once a user distro can appear', () => {
    vi.useFakeTimers()
    runProcessSyncMock.mockReturnValueOnce(exited('docker-desktop\ndocker-desktop-data\n'))
    runProcessSyncMock.mockReturnValueOnce(exited('docker-desktop\nUbuntu\n'))

    try {
      withPlatform('win32', () => {
        expect(listWslDistros()).toEqual([])
        expect(getCachedWslDistros()).toEqual([])
        expect(listWslDistros()).toEqual([])
        expect(runProcessSyncMock).toHaveBeenCalledTimes(1)
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
    runProcessSyncMock.mockReturnValue(exited(''))

    try {
      withPlatform('win32', () => {
        expect(listWslDistros()).toEqual([])
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual([])
        expect(runProcessSyncMock).toHaveBeenCalledTimes(2)
        // Second empty result doubles the window, so 15s more is not enough.
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual([])
        expect(runProcessSyncMock).toHaveBeenCalledTimes(2)
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual([])
        expect(runProcessSyncMock).toHaveBeenCalledTimes(3)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('backs off after repeated distro-list failures', () => {
    vi.useFakeTimers()
    runProcessSyncMock.mockReturnValue(TIMED_OUT)

    try {
      withPlatform('win32', () => {
        expect(listWslDistros()).toEqual([])
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual([])
        expect(runProcessSyncMock).toHaveBeenCalledTimes(2)
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual([])
        expect(runProcessSyncMock).toHaveBeenCalledTimes(2)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the cap is the only bound on how long a distro installed mid-session stays
  // invisible, so pin it rather than letting the doubling run away.
  it('caps the empty-list backoff at five minutes', () => {
    vi.useFakeTimers()
    runProcessSyncMock.mockReturnValue(exited(''))

    try {
      withPlatform('win32', () => {
        // Windows double to 15/30/60/120/240s, so the 6th would be 480s uncapped.
        for (const delayMs of [0, 15_000, 30_000, 60_000, 120_000, 240_000]) {
          vi.advanceTimersByTime(delayMs)
          listWslDistros()
        }
        expect(runProcessSyncMock).toHaveBeenCalledTimes(6)
        vi.advanceTimersByTime(300_000)
        listWslDistros()
        expect(runProcessSyncMock).toHaveBeenCalledTimes(7)
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
    runProcessSyncMock.mockReturnValue(exited(''))

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
    runProcessSyncMock.mockReturnValueOnce(exited('Ubuntu\n'))

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

describe('WSL home cache', () => {
  afterEach(() => {
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
    _resetWslCachesForTests()
  })

  it('bounds cached homes while retaining the most recently used distros', () => {
    runProcessSyncMock.mockImplementation(({ args }: { args: string[] }) =>
      exited(`/home/${args[1]}\n`)
    )

    withPlatform('win32', () => {
      for (let index = 0; index < 68; index += 1) {
        expect(getWslHome(`Distro-${index}`)).toContain(`Distro-${index}`)
      }
      expect(getWslHome('Distro-4')).toContain('Distro-4')
      expect(runProcessSyncMock).toHaveBeenCalledTimes(68)
      expect(getWslHome('Distro-0')).toContain('Distro-0')
      expect(runProcessSyncMock).toHaveBeenCalledTimes(69)
    })
  })
})

describe('WSL availability cache', () => {
  afterEach(() => {
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
    _resetWslCachesForTests()
  })

  // Why: a cold WSL2 utility-VM boot on a just-installed or just-rebooted
  // machine routinely exceeds the 5s probe timeout. Latching false for the
  // process lifetime is what makes WSL vanish from the picker after setup.
  it('retries availability after a probe timeout instead of latching false', async () => {
    vi.useFakeTimers()
    runProcessMock.mockResolvedValueOnce(TIMED_OUT).mockResolvedValueOnce(exited(''))

    try {
      await withPlatformAsync('win32', async () => {
        await expect(isWslAvailableAsync()).resolves.toBe(false)
        vi.advanceTimersByTime(45_000)
        await expect(isWslAvailableAsync()).resolves.toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: a timeout must not let every caller re-spawn wsl.exe immediately.
  it('bounds the probe rate while the failure window is open', async () => {
    runProcessMock.mockResolvedValue(TIMED_OUT)

    await withPlatformAsync('win32', async () => {
      await expect(isWslAvailableAsync()).resolves.toBe(false)
      await expect(isWslAvailableAsync()).resolves.toBe(false)
      expect(runProcessMock).toHaveBeenCalledTimes(1)
    })
  })

  it('caches a successful probe for the process lifetime', async () => {
    runProcessMock.mockResolvedValueOnce(exited(''))

    await withPlatformAsync('win32', async () => {
      await expect(isWslAvailableAsync()).resolves.toBe(true)
      await expect(isWslAvailableAsync()).resolves.toBe(true)
      expect(runProcessMock).toHaveBeenCalledTimes(1)
    })
  })

  // Why this site matters more than the other wsl.exe spawns (#16463): ENOENT is
  // deliberately non-retryable here, so a spawn that failed only because the
  // inherited cwd had been deleted was cached as "WSL is not installed" on the
  // 10-minute definitive TTL with exponential backoff. Git kept working and Orca
  // reported WSL unavailable -- a worse state than the bug being fixed. Naming
  // the directory is what keeps ENOENT meaning "wsl.exe is not on PATH".
  it('names an explicit spawn directory, so no deleted cwd can read as ENOENT', async () => {
    runProcessMock.mockResolvedValue(exited(''))

    await withPlatformAsync('win32', async () => {
      await expect(isWslAvailableAsync()).resolves.toBe(true)
    })
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'wsl.exe',
        args: ['--status'],
        timeoutMs: 5000,
        cwd: 'C:\\Windows'
      })
    )
  })

  it('shares one wsl.exe spawn between concurrent probes', async () => {
    runProcessMock.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(exited('')), 0))
    )

    await withPlatformAsync('win32', async () => {
      const results = await Promise.all([isWslAvailableAsync(), isWslAvailableAsync()])
      expect(results).toEqual([true, true])
      expect(runProcessMock).toHaveBeenCalledTimes(1)
    })
  })

  it('does not restore a failure after distro discovery disproves it mid-probe', async () => {
    const callbacks = new Map<string, (result: ProcessResult) => void>()
    runProcessMock.mockImplementation(
      ({ args }: { args: string[] }) =>
        new Promise((resolve) => {
          callbacks.set(args.join(' '), resolve)
        })
    )

    await withPlatformAsync('win32', async () => {
      const staleAvailability = isWslAvailableAsync()
      const distroProbe = listWslDistrosAsync()
      callbacks.get('--list --quiet')?.(exited('Ubuntu\n'))
      await expect(distroProbe).resolves.toEqual(['Ubuntu'])

      callbacks.get('--status')?.(exited('', 1))
      await expect(staleAvailability).resolves.toBe(false)
      expect(getCachedWslAvailability()).toBeNull()

      const retry = isWslAvailableAsync()
      callbacks.get('--status')?.(exited(''))
      await expect(retry).resolves.toBe(true)
    })
  })

  // Why: the resolver reads the cached getter, not the probe. Reporting the last
  // observed answer keeps the `wsl-unavailable` repair prompt reachable; going null
  // on staleness would let git and PTY silently resolve to a WSL that just failed.
  it('keeps reporting the last observed answer after it goes stale', async () => {
    vi.useFakeTimers()
    runProcessMock.mockResolvedValue(TIMED_OUT)

    try {
      await withPlatformAsync('win32', async () => {
        await expect(isWslAvailableAsync()).resolves.toBe(false)
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
  // still starting, which is transient. wsl.exe ships in System32 on every modern
  // Windows, so a host without WSL usually answers with a non-zero exit, not ENOENT.
  it.each([
    ['wsl.exe reports WSL unusable', () => Promise.resolve(exited('', 1))],
    ['wsl.exe is not installed', () => Promise.reject(spawnError('ENOENT'))]
  ])('holds a definitive failure far longer than a timeout when %s', async (_label, probe) => {
    vi.useFakeTimers()
    runProcessMock.mockImplementationOnce(probe).mockResolvedValueOnce(exited(''))

    try {
      await withPlatformAsync('win32', async () => {
        await expect(isWslAvailableAsync()).resolves.toBe(false)
        vi.advanceTimersByTime(45_000)
        await expect(isWslAvailableAsync()).resolves.toBe(false)
        expect(getCachedWslAvailability()).toBe(false)
        expect(runProcessMock).toHaveBeenCalledTimes(1)
        vi.advanceTimersByTime(10 * 60_000)
        await expect(isWslAvailableAsync()).resolves.toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: a wedged wsl.exe must not be re-probed on every window boundary for the
  // rest of the session.
  it('backs off after repeated probe failures', async () => {
    vi.useFakeTimers()
    runProcessMock.mockResolvedValue(TIMED_OUT)

    try {
      await withPlatformAsync('win32', async () => {
        await expect(isWslAvailableAsync()).resolves.toBe(false)
        vi.advanceTimersByTime(45_000)
        await expect(isWslAvailableAsync()).resolves.toBe(false)
        expect(runProcessMock).toHaveBeenCalledTimes(2)
        // Second failure doubles the window, so the next boundary is not enough.
        vi.advanceTimersByTime(45_000)
        await expect(isWslAvailableAsync()).resolves.toBe(false)
        expect(runProcessMock).toHaveBeenCalledTimes(2)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: a seeded retryable failure must re-probe once its window lapses, the same
  // as one observed live — otherwise test setup can hide the latch this fixes.
  it('re-probes a seeded retryable failure once its window lapses', async () => {
    vi.useFakeTimers()
    runProcessMock.mockResolvedValueOnce(exited(''))

    try {
      await withPlatformAsync('win32', async () => {
        _setWslCachesForTests({ available: false, availabilityRetryable: true })
        await expect(isWslAvailableAsync()).resolves.toBe(false)
        vi.advanceTimersByTime(45_000)
        await expect(isWslAvailableAsync()).resolves.toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the caches expire independently and `getWslRepairReason` checks availability
  // first, so a definitive failure held for 10min would report `wsl-unavailable` over a
  // WSL that just listed a distro. Finding a distro must drop the stale failure.
  it.each([
    ['a definitive failure', exited('', 1)],
    ['a timeout', TIMED_OUT]
  ])('re-probes availability once a distro list succeeds after %s', async (_label, failure) => {
    vi.useFakeTimers()
    runProcessMock.mockResolvedValueOnce(failure)

    try {
      await withPlatformAsync('win32', async () => {
        await expect(isWslAvailableAsync()).resolves.toBe(false)

        // A distro turns up (WSL finished provisioning / was repaired mid-session).
        runProcessSyncMock.mockReturnValueOnce(exited('Ubuntu\n'))
        expect(listWslDistros()).toEqual(['Ubuntu'])

        // Without dropping the stale failure this would stay false for 10min.
        runProcessMock.mockResolvedValueOnce(exited(''))
        await expect(isWslAvailableAsync()).resolves.toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: an empty list re-probes on a 15s-to-5min schedule, so clearing the availability
  // failure on every empty probe would re-spawn the availability probe far too often.
  it('does not drop an availability failure for an empty distro list', async () => {
    vi.useFakeTimers()
    runProcessMock.mockResolvedValueOnce(exited('', 1))

    try {
      await withPlatformAsync('win32', async () => {
        await expect(isWslAvailableAsync()).resolves.toBe(false)
        runProcessSyncMock.mockReturnValueOnce(exited(''))
        expect(listWslDistros()).toEqual([])
        expect(getCachedWslAvailability()).toBe(false)
        // Still inside the definitive window, so no re-probe was paid.
        await expect(isWslAvailableAsync()).resolves.toBe(false)
        expect(runProcessMock).toHaveBeenCalledTimes(1)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps reporting unavailable off Windows without probing', async () => {
    await withPlatformAsync('darwin', async () => {
      await expect(isWslAvailableAsync()).resolves.toBe(false)
      expect(getCachedWslAvailability()).toBe(false)
      expect(runProcessMock).not.toHaveBeenCalled()
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

describe('wslUncDirectoryExistsAsync', () => {
  afterEach(() => {
    runProcessMock.mockReset()
  })

  it('returns true when the distro reports the directory exists', async () => {
    runProcessMock.mockResolvedValue(exited('__ORCA_DIRECTORY_EXISTS__'))

    await expect(
      withPlatformAsync('win32', () =>
        wslUncDirectoryExistsAsync('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')
      )
    ).resolves.toBe(true)
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'wsl.exe',
        timeoutMs: 5000,
        args: [
          '-d',
          'Ubuntu',
          '--exec',
          'sh',
          '-c',
          expect.stringContaining('__ORCA_DIRECTORY_EXISTS__'),
          'sh',
          '/home/jin/repo'
        ]
      })
    )
  })

  it('distinguishes a missing directory from an inconclusive probe', async () => {
    runProcessMock
      .mockResolvedValueOnce(exited('__ORCA_DIRECTORY_MISSING__'))
      .mockResolvedValueOnce(exited('', 4294967295))

    await withPlatformAsync('win32', async () => {
      await expect(
        wslUncDirectoryExistsAsync('\\\\wsl.localhost\\Ubuntu\\home\\jin\\missing')
      ).resolves.toBe(false)
      await expect(
        wslUncDirectoryExistsAsync('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')
      ).resolves.toBeNull()
    })
  })

  it('returns null without spawning for paths outside WSL or off Windows', async () => {
    await expect(
      withPlatformAsync('win32', () => wslUncDirectoryExistsAsync('C:\\Users\\jin\\repo'))
    ).resolves.toBeNull()
    await expect(
      withPlatformAsync('linux', () =>
        wslUncDirectoryExistsAsync('\\\\wsl.localhost\\Ubuntu\\home\\jin')
      )
    ).resolves.toBeNull()
    expect(runProcessMock).not.toHaveBeenCalled()
  })
})
