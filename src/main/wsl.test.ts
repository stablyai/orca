import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../shared/child-process/run-process'

const { runProcessMock, runProcessSyncMock } = vi.hoisted(() => ({
  runProcessMock: vi.fn<(spec: ProcessSpec) => Promise<ProcessResult>>(),
  runProcessSyncMock: vi.fn<(spec: ProcessSpec) => ProcessResult>()
}))

vi.mock('../shared/child-process/run-process', () => ({
  runProcess: runProcessMock,
  runProcessSync: runProcessSyncMock
}))

import {
  _resetWslCachesForTests,
  _setWslCachesForTests,
  getCachedWslAvailability,
  getCachedWslDistros,
  hasCachedWslAvailability,
  hasCachedWslDistros,
  isWslAvailable,
  isWslAvailableAsync,
  listWslDistros,
  listWslDistrosAsync,
  parseWslPath,
  toLinuxPath,
  toWindowsWslPath,
  wslUncDirectoryExists,
  wslUncDirectoryExistsAsync
} from './wsl'

/** A wsl.exe run that printed `stdout` and exited with `code`. */
function exited(stdout: string, code = 0): ProcessResult {
  return { code, signal: null, stdout, stderr: '', timedOut: false }
}

/** How `runProcess`/`runProcessSync` report a probe they had to kill. */
function killedByTimeout(): ProcessResult {
  return {
    code: null,
    signal: 'SIGTERM',
    stdout: '',
    stderr: '',
    timedOut: true
  }
}

function withPlatform<T>(value: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: original
    })
  }
}

async function withPlatformAsync<T>(value: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: original
    })
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
    runProcessMock
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValueOnce(exited('Ubuntu\n'))

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
    runProcessSyncMock.mockImplementationOnce(() => {
      throw new Error('transient failure')
    })
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

  // Why: a non-zero exit no longer throws at the spawn layer, so the retry window has to
  // be armed from the exit code instead — otherwise a failing `--list` caches as [].
  it('retries synchronous discovery after wsl.exe exits non-zero', () => {
    vi.useFakeTimers()
    runProcessSyncMock.mockReturnValueOnce(exited('', 1))
    runProcessSyncMock.mockReturnValueOnce(exited('Ubuntu\n'))

    try {
      withPlatform('win32', () => {
        expect(listWslDistros()).toEqual([])
        expect(getCachedWslDistros()).toBeNull()
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
    runProcessSyncMock.mockImplementation(() => {
      throw new Error('transient failure')
    })

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

describe('WSL availability cache', () => {
  afterEach(() => {
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
    _resetWslCachesForTests()
  })

  // Why: a cold WSL2 utility-VM boot on a just-installed or just-rebooted
  // machine routinely exceeds the 5s probe timeout. Latching false for the
  // process lifetime is what makes WSL vanish from the picker after setup.
  it('retries availability after a probe timeout instead of latching false', () => {
    vi.useFakeTimers()
    runProcessSyncMock.mockReturnValueOnce(killedByTimeout())
    runProcessSyncMock.mockReturnValueOnce(exited(''))

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
    runProcessSyncMock.mockReturnValue(killedByTimeout())

    withPlatform('win32', () => {
      expect(isWslAvailable()).toBe(false)
      expect(isWslAvailable()).toBe(false)
      expect(runProcessSyncMock).toHaveBeenCalledTimes(1)
    })
  })

  it('caches a successful probe for the process lifetime', () => {
    runProcessSyncMock.mockReturnValueOnce(exited(''))

    withPlatform('win32', () => {
      expect(isWslAvailable()).toBe(true)
      expect(isWslAvailable()).toBe(true)
      expect(runProcessSyncMock).toHaveBeenCalledTimes(1)
    })
  })

  // Why: the renderer's capability read reaches this over IPC; a blocking spawn there
  // stalls every PTY message and window IPC for as long as wsl.exe takes to answer.
  it('probes availability for IPC callers without blocking the main thread', async () => {
    runProcessMock.mockResolvedValue(exited(''))

    await withPlatformAsync('win32', async () => {
      await expect(isWslAvailableAsync()).resolves.toBe(true)
      expect(runProcessMock).toHaveBeenCalledWith(
        expect.objectContaining({
          program: 'wsl.exe',
          args: ['--status'],
          timeoutMs: 5000
        })
      )
      expect(runProcessSyncMock).not.toHaveBeenCalled()
    })
  })

  // Why this site matters more than the other wsl.exe spawns (#16463): ENOENT is
  // deliberately non-retryable here, so a spawn that failed only because the
  // inherited cwd had been deleted was cached as "WSL is not installed" on the
  // 10-minute definitive TTL with exponential backoff. Git kept working and Orca
  // reported WSL unavailable -- a worse state than the bug being fixed. Naming
  // the directory is what keeps ENOENT meaning "wsl.exe is not on PATH".
  it('names an explicit spawn directory on both probes, so no deleted cwd can read as ENOENT', async () => {
    runProcessSyncMock.mockReturnValueOnce(exited(''))
    runProcessMock.mockResolvedValue(exited(''))

    withPlatform('win32', () => {
      expect(isWslAvailable()).toBe(true)
    })
    expect(runProcessSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['--status'], cwd: expect.any(String) })
    )

    // The two probes share one cache, so a false ENOENT from either poisons both.
    _resetWslCachesForTests()
    await withPlatformAsync('win32', async () => {
      await expect(isWslAvailableAsync()).resolves.toBe(true)
    })
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['--status'], cwd: expect.any(String) })
    )
  })

  it('shares one wsl.exe spawn between concurrent async probes', async () => {
    runProcessMock.mockResolvedValue(exited(''))

    await withPlatformAsync('win32', async () => {
      const results = await Promise.all([isWslAvailableAsync(), isWslAvailableAsync()])
      expect(results).toEqual([true, true])
      expect(runProcessMock).toHaveBeenCalledTimes(1)
    })
  })

  it('does not let an older async failure overwrite a newer sync success', async () => {
    let finishAsyncProbe: ((result: ProcessResult) => void) | null = null
    runProcessMock.mockImplementation(
      () =>
        new Promise<ProcessResult>((resolve) => {
          finishAsyncProbe = resolve
        })
    )
    runProcessSyncMock.mockReturnValue(exited(''))

    await withPlatformAsync('win32', async () => {
      const staleProbe = isWslAvailableAsync()
      expect(isWslAvailable()).toBe(true)

      finishAsyncProbe?.(exited('', 1))

      await expect(staleProbe).resolves.toBe(true)
      expect(getCachedWslAvailability()).toBe(true)
    })
  })

  it('does not restore a failure after distro discovery disproves it mid-probe', async () => {
    const resolvers = new Map<string, (result: ProcessResult) => void>()
    runProcessMock.mockImplementation(
      (spec) =>
        new Promise<ProcessResult>((resolve) => {
          resolvers.set((spec.args ?? []).join(' '), resolve)
        })
    )

    await withPlatformAsync('win32', async () => {
      const staleAvailability = isWslAvailableAsync()
      const distroProbe = listWslDistrosAsync()
      resolvers.get('--list --quiet')?.(exited('Ubuntu\n'))
      await expect(distroProbe).resolves.toEqual(['Ubuntu'])

      resolvers.get('--status')?.(exited('', 1))
      await expect(staleAvailability).resolves.toBe(false)
      expect(getCachedWslAvailability()).toBeNull()

      const retry = isWslAvailableAsync()
      resolvers.get('--status')?.(exited(''))
      await expect(retry).resolves.toBe(true)
    })
  })

  it('shares the failure backoff between the async and sync probes', async () => {
    runProcessMock.mockRejectedValue(Object.assign(new Error('not installed'), { code: 'ENOENT' }))

    await withPlatformAsync('win32', async () => {
      await expect(isWslAvailableAsync()).resolves.toBe(false)
      expect(isWslAvailable()).toBe(false)
      expect(runProcessSyncMock).not.toHaveBeenCalled()
    })
  })

  // Why: wsl.exe ships in System32 on every modern Windows, so a host without WSL answers
  // with a non-zero exit, not ENOENT. Misreading that as retryable would shrink the shared
  // cache window to 45s and make the sync callers pay their blocking spawn ~13x more often.
  it('treats a non-zero async exit as definitive, so the sync probe keeps the long window', async () => {
    vi.useFakeTimers()
    runProcessMock.mockResolvedValue(exited('', 1))
    runProcessSyncMock.mockReturnValue(exited(''))

    try {
      await withPlatformAsync('win32', async () => {
        await expect(isWslAvailableAsync()).resolves.toBe(false)
        vi.advanceTimersByTime(45_000)
        expect(isWslAvailable()).toBe(false)
        expect(runProcessSyncMock).not.toHaveBeenCalled()
        vi.advanceTimersByTime(10 * 60_000)
        expect(isWslAvailable()).toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: the resolver reads the cached getter, not the probe. Reporting the last
  // observed answer keeps the `wsl-unavailable` repair prompt reachable; going null
  // on staleness would let git and PTY silently resolve to a WSL that just failed.
  it('keeps reporting the last observed answer after it goes stale', () => {
    vi.useFakeTimers()
    runProcessSyncMock.mockReturnValue(killedByTimeout())

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
    ['wsl.exe reports WSL unusable', () => runProcessSyncMock.mockReturnValueOnce(exited('', 1))],
    [
      'wsl.exe is not installed',
      () =>
        runProcessSyncMock.mockImplementationOnce(() => {
          throw Object.assign(new Error('definitive failure'), {
            code: 'ENOENT'
          })
        })
    ]
  ])('holds a definitive failure far longer than a timeout when %s', (_label, failFirstProbe) => {
    vi.useFakeTimers()
    failFirstProbe()
    runProcessSyncMock.mockReturnValueOnce(exited(''))

    try {
      withPlatform('win32', () => {
        expect(isWslAvailable()).toBe(false)
        vi.advanceTimersByTime(45_000)
        expect(isWslAvailable()).toBe(false)
        expect(getCachedWslAvailability()).toBe(false)
        expect(runProcessSyncMock).toHaveBeenCalledTimes(1)
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
    runProcessSyncMock.mockReturnValue(killedByTimeout())

    try {
      withPlatform('win32', () => {
        expect(isWslAvailable()).toBe(false)
        vi.advanceTimersByTime(45_000)
        expect(isWslAvailable()).toBe(false)
        expect(runProcessSyncMock).toHaveBeenCalledTimes(2)
        // Second failure doubles the window, so the next boundary is not enough.
        vi.advanceTimersByTime(45_000)
        expect(isWslAvailable()).toBe(false)
        expect(runProcessSyncMock).toHaveBeenCalledTimes(2)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  // Why: a seeded retryable failure must re-probe once its window lapses, the same
  // as one observed live — otherwise test setup can hide the latch this fixes.
  it('re-probes a seeded retryable failure once its window lapses', () => {
    vi.useFakeTimers()
    runProcessSyncMock.mockReturnValueOnce(exited(''))

    try {
      withPlatform('win32', () => {
        _setWslCachesForTests({
          available: false,
          availabilityRetryable: true
        })
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
    ['a definitive failure', () => exited('', 1)],
    ['a timeout', () => killedByTimeout()]
  ])('re-probes availability once a distro list succeeds after %s', (_label, failure) => {
    vi.useFakeTimers()
    runProcessSyncMock.mockReturnValueOnce(failure())

    try {
      withPlatform('win32', () => {
        expect(isWslAvailable()).toBe(false)

        // A distro turns up (WSL finished provisioning / was repaired mid-session).
        runProcessSyncMock.mockReturnValueOnce(exited('Ubuntu\n'))
        expect(listWslDistros()).toEqual(['Ubuntu'])

        // Without dropping the stale failure this would stay false for 10min.
        runProcessSyncMock.mockReturnValueOnce(exited(''))
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
    runProcessSyncMock.mockReturnValueOnce(exited('', 1))

    try {
      withPlatform('win32', () => {
        expect(isWslAvailable()).toBe(false)
        runProcessSyncMock.mockReturnValueOnce(exited(''))
        expect(listWslDistros()).toEqual([])
        expect(getCachedWslAvailability()).toBe(false)
        // Still inside the definitive window, so no re-probe was paid.
        expect(runProcessSyncMock).toHaveBeenCalledTimes(2)
        expect(isWslAvailable()).toBe(false)
        expect(runProcessSyncMock).toHaveBeenCalledTimes(2)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps reporting unavailable off Windows without probing', () => {
    withPlatform('darwin', () => {
      expect(isWslAvailable()).toBe(false)
      expect(getCachedWslAvailability()).toBe(false)
      expect(runProcessSyncMock).not.toHaveBeenCalled()
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

const DIRECTORY_PROBE_ARGS = [
  '-d',
  'Ubuntu',
  '--exec',
  'sh',
  '-c',
  expect.stringContaining('__ORCA_DIRECTORY_EXISTS__'),
  'sh',
  '/home/jin/repo'
]

describe('wslUncDirectoryExists', () => {
  afterEach(() => {
    runProcessSyncMock.mockReset()
  })

  it('returns true when the distro reports the directory exists', () => {
    runProcessSyncMock.mockReturnValue(exited('__ORCA_DIRECTORY_EXISTS__'))
    const result = withPlatform('win32', () =>
      wslUncDirectoryExists('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')
    )
    expect(result).toBe(true)
    expect(runProcessSyncMock).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'wsl.exe',
        args: DIRECTORY_PROBE_ARGS,
        timeoutMs: 5000
      })
    )
  })

  it('returns false when the guest reports the directory missing', () => {
    runProcessSyncMock.mockReturnValue(exited('__ORCA_DIRECTORY_MISSING__'))
    const result = withPlatform('win32', () =>
      wslUncDirectoryExists('\\\\wsl.localhost\\Ubuntu\\home\\jin\\missing')
    )
    expect(result).toBe(false)
  })

  // Why the exit code is not consulted: wsl.exe uses numeric exits for guest results and
  // host failures alike, so only the marker distinguishes "missing" from "could not ask".
  it('returns null when wsl.exe or the distro is unavailable', () => {
    runProcessSyncMock.mockReturnValue(exited('', 4294967295))
    expect(
      withPlatform('win32', () =>
        wslUncDirectoryExists('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')
      )
    ).toBeNull()

    runProcessSyncMock.mockImplementation(() => {
      throw new Error('distro unavailable')
    })
    expect(
      withPlatform('win32', () =>
        wslUncDirectoryExists('\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo')
      )
    ).toBeNull()
  })

  it('returns null for non-WSL paths and off Windows', () => {
    expect(withPlatform('win32', () => wslUncDirectoryExists('C:\\Users\\jin\\repo'))).toBeNull()
    expect(
      withPlatform('linux', () => wslUncDirectoryExists('\\\\wsl.localhost\\Ubuntu\\home\\jin'))
    ).toBeNull()
    expect(runProcessSyncMock).not.toHaveBeenCalled()
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
        args: DIRECTORY_PROBE_ARGS,
        timeoutMs: 5000
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
