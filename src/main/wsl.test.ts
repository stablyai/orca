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
  getCachedWslDistros,
  listWslDistros,
  listWslDistrosAsync,
  parseWslPath,
  toLinuxPath,
  toWindowsWslPath,
  wslUncDirectoryExists
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
