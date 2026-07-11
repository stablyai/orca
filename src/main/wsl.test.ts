import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as childProcess from 'node:child_process'

const { execFileSyncMock, execFileMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  execFileMock: vi.fn()
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return {
    ...actual,
    execFileSync: execFileSyncMock,
    execFile: execFileMock
  }
})

import {
  toLinuxPath,
  toWindowsWslPath,
  parseWslPath,
  wslUncDirectoryExists,
  listWslDistrosAsync,
  isWslAvailableAsync,
  _resetWslCachesForTests,
  _setWslCachesForTests
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

async function withPlatformAsync<T>(value: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: original })
  }
}

describe('WSL availability/distro cache refresh', () => {
  afterEach(() => {
    execFileMock.mockReset()
    _resetWslCachesForTests()
  })

  it('serves the sticky distro cache until refresh forces a re-probe', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, out: string) => void) => {
        cb(null, 'Ubuntu\nDebian\n')
      }
    )
    // A prior probe found nothing and stuck.
    _setWslCachesForTests({ distros: [] })

    const cached = await withPlatformAsync('win32', () => listWslDistrosAsync())
    expect(cached).toEqual([])
    expect(execFileMock).not.toHaveBeenCalled()

    const refreshed = await withPlatformAsync('win32', () => listWslDistrosAsync({ refresh: true }))
    expect(refreshed).toEqual(['Ubuntu', 'Debian'])
    expect(execFileMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['--list', '--quiet'],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function)
    )
  })

  it('serves the sticky availability cache until refresh forces a re-probe', async () => {
    execFileMock.mockImplementation(
      (_cmd: string, _args: string[], _opts: unknown, cb: (e: unknown, out: string) => void) => {
        cb(null, '')
      }
    )
    // A prior probe reported WSL missing and stuck.
    _setWslCachesForTests({ available: false })

    const cached = await withPlatformAsync('win32', () => isWslAvailableAsync())
    expect(cached).toBe(false)
    expect(execFileMock).not.toHaveBeenCalled()

    const refreshed = await withPlatformAsync('win32', () => isWslAvailableAsync({ refresh: true }))
    expect(refreshed).toBe(true)
    expect(execFileMock).toHaveBeenCalledWith(
      'wsl.exe',
      ['--status'],
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function)
    )
  })
})
