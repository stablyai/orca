import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'
import { assertWslDistroAllowed } from '@orca/process-host/wsl-distro-allowlist'

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
// These cases model hosts with no registered distro; the lost-output fallback has its own suite.
vi.mock('./wsl-registered-distro-fallback', () => ({
  listedOrRegisteredWslDistros: async (listed: string[]) => listed,
  readRegisteredWslDistrosLater: () => {},
  isWslListOutputLost: () => false,
  resetWslListOutputLost: () => {},
  runningWhenListedNone: async () => []
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
  getWslHomeAsync,
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

  it('backs off while the list keeps coming back empty', () => {
    vi.useFakeTimers()
    runProcessSyncMock.mockReturnValue(exited(''))

    try {
      withPlatform('win32', () => {
        expect(listWslDistros()).toEqual([])
        vi.advanceTimersByTime(15_000)
        expect(listWslDistros()).toEqual([])
        expect(runProcessSyncMock).toHaveBeenCalledTimes(2)
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

  it('caps the empty-list backoff at five minutes', () => {
    vi.useFakeTimers()
    runProcessSyncMock.mockReturnValue(exited(''))

    try {
      withPlatform('win32', () => {
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

describe('WSL probes under the internal distro allowlist', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    runProcessMock.mockReset()
    _resetWslCachesForTests()
  })

  it('still lists distros, and an excluded distro home probe fails like any other probe', async () => {
    vi.stubEnv('ORCA_INTERNAL_WSL_DISTRO_ALLOWLIST', 'orca-test-a')
    // Stands in for process-host: the real check runs before a child would start.
    runProcessMock.mockImplementation(async (spec: { program: string; args: string[] }) => {
      assertWslDistroAllowed(spec.program, spec.args)
      return spec.args.includes('--list')
        ? exited('Ubuntu\norca-test-a\n')
        : exited('/home/alice\n')
    })
    await withPlatformAsync('win32', async () => {
      await expect(listWslDistrosAsync()).resolves.toEqual(['Ubuntu', 'orca-test-a'])
      await expect(getWslHomeAsync('Ubuntu')).resolves.toBeNull()
      await expect(getWslHomeAsync('orca-test-a')).resolves.toContain('alice')
    })
  })
})

describe('WSL home probe on a booting distro', () => {
  afterEach(() => {
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
    _resetWslCachesForTests()
  })

  // Real host (win-lowspec): a 5 s kill mid-boot left the distro failing every wsl.exe call.
  it('gives the async home probe time for a cold boot instead of killing it at 5 s', async () => {
    runProcessMock.mockResolvedValueOnce(exited('/home/alice\n'))
    await withPlatformAsync('win32', () => getWslHomeAsync('Ubuntu'))
    expect(runProcessMock.mock.calls[0]?.[0]).toMatchObject({ program: 'wsl.exe' })
    expect(runProcessMock.mock.calls[0]?.[0]?.timeoutMs).toBeGreaterThanOrEqual(30_000)
  })

  it('never starts a 5 s synchronous probe while the async one waits out a boot', async () => {
    let finish!: (result: ProcessResult) => void
    runProcessMock.mockReturnValueOnce(new Promise<ProcessResult>((resolve) => (finish = resolve)))
    await withPlatformAsync('win32', async () => {
      const pending = getWslHomeAsync('Ubuntu')
      expect(getWslHome('Ubuntu')).toBeNull()
      expect(runProcessSyncMock).not.toHaveBeenCalled()
      finish(exited('/home/alice\n'))
      expect(await pending).toContain('alice')
    })
  })
})

describe('WSL availability cache', () => {
  afterEach(() => {
    runProcessMock.mockReset()
    runProcessSyncMock.mockReset()
    _resetWslCachesForTests()
  })

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

  // WSL servicing can return nonzero status; definitive-looking failures still need retries.
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

  it('backs off after repeated probe failures', async () => {
    vi.useFakeTimers()
    runProcessMock.mockResolvedValue(TIMED_OUT)

    try {
      await withPlatformAsync('win32', async () => {
        await expect(isWslAvailableAsync()).resolves.toBe(false)
        vi.advanceTimersByTime(45_000)
        await expect(isWslAvailableAsync()).resolves.toBe(false)
        expect(runProcessMock).toHaveBeenCalledTimes(2)
        vi.advanceTimersByTime(45_000)
        await expect(isWslAvailableAsync()).resolves.toBe(false)
        expect(runProcessMock).toHaveBeenCalledTimes(2)
      })
    } finally {
      vi.useRealTimers()
    }
  })

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

  it.each([
    ['a definitive failure', exited('', 1)],
    ['a timeout', TIMED_OUT]
  ])('re-probes availability once a distro list succeeds after %s', async (_label, failure) => {
    vi.useFakeTimers()
    runProcessMock.mockResolvedValueOnce(failure)

    try {
      await withPlatformAsync('win32', async () => {
        await expect(isWslAvailableAsync()).resolves.toBe(false)

        runProcessSyncMock.mockReturnValueOnce(exited('Ubuntu\n'))
        expect(listWslDistros()).toEqual(['Ubuntu'])

        runProcessMock.mockResolvedValueOnce(exited(''))
        await expect(isWslAvailableAsync()).resolves.toBe(true)
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not drop an availability failure for an empty distro list', async () => {
    vi.useFakeTimers()
    runProcessMock.mockResolvedValueOnce(exited('', 1))

    try {
      await withPlatformAsync('win32', async () => {
        await expect(isWslAvailableAsync()).resolves.toBe(false)
        runProcessSyncMock.mockReturnValueOnce(exited(''))
        expect(listWslDistros()).toEqual([])
        expect(getCachedWslAvailability()).toBe(false)
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
