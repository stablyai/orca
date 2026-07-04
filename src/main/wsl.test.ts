import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as childProcess from 'node:child_process'

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn()
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof childProcess>()
  return {
    ...actual,
    execFileSync: execFileSyncMock
  }
})

import { toLinuxPath, toWindowsWslPath, parseWslPath, wslUncDirectoryExists } from './wsl'

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
