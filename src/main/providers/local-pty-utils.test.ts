import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as fs from 'node:fs'
import type { Stats } from 'node:fs'

const { existsSyncMock, statSyncMock, accessSyncMock, wslUncDirectoryExistsMock, wrapSpawnMock } =
  vi.hoisted(() => ({
    existsSyncMock: vi.fn(),
    statSyncMock: vi.fn(),
    accessSyncMock: vi.fn(),
    wslUncDirectoryExistsMock: vi.fn(),
    wrapSpawnMock: vi.fn()
  }))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    existsSync: existsSyncMock,
    statSync: statSyncMock,
    accessSync: accessSyncMock
  }
})

function dirStats(isDirectory: boolean): Stats {
  return { isDirectory: () => isDirectory } as Stats
}

vi.mock('../wsl', () => ({
  wslUncDirectoryExists: wslUncDirectoryExistsMock
}))

vi.mock('./macos-tcc-login-shell', () => ({
  wrapShellSpawnForMacosTccAttribution: wrapSpawnMock
}))

import { spawnShellWithFallback, validateWorkingDirectory } from './local-pty-utils'

const WSL_UNC_DIR = '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
const NATIVE_DIR = 'C:\\Users\\jin\\repo'

describe('validateWorkingDirectory', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    statSyncMock.mockReset()
    wslUncDirectoryExistsMock.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts a WSL UNC worktree that exists inside the distro even when fs.statSync would fail', () => {
    // Why: the Win32 9P stat is the exact path that falsely reported ENOENT and
    // broke opening WSL worktrees. The distro answer must win.
    wslUncDirectoryExistsMock.mockReturnValue(true)
    existsSyncMock.mockReturnValue(false)

    expect(() => validateWorkingDirectory(WSL_UNC_DIR)).not.toThrow()
    expect(wslUncDirectoryExistsMock).toHaveBeenCalledWith(WSL_UNC_DIR)
    // The fs fallback must not run when the distro confirmed existence.
    expect(existsSyncMock).not.toHaveBeenCalled()
  })

  it('rejects a WSL UNC worktree that does not exist inside the distro', () => {
    wslUncDirectoryExistsMock.mockReturnValue(false)

    expect(() => validateWorkingDirectory(WSL_UNC_DIR)).toThrow(/does not exist/)
    expect(existsSyncMock).not.toHaveBeenCalled()
  })

  it('falls back to the fs check when the distro answer is inconclusive', () => {
    wslUncDirectoryExistsMock.mockReturnValue(null)
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue(dirStats(true))

    expect(() => validateWorkingDirectory(WSL_UNC_DIR)).not.toThrow()
    expect(wslUncDirectoryExistsMock).toHaveBeenCalledWith(WSL_UNC_DIR)
    expect(existsSyncMock).toHaveBeenCalledWith(WSL_UNC_DIR)
  })

  it('validates native Windows paths via fs without consulting the distro', () => {
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue(dirStats(true))

    expect(() => validateWorkingDirectory(NATIVE_DIR)).not.toThrow()
    expect(wslUncDirectoryExistsMock).not.toHaveBeenCalled()
    expect(existsSyncMock).toHaveBeenCalledWith(NATIVE_DIR)
  })

  it('rejects a missing native Windows path', () => {
    existsSyncMock.mockReturnValue(false)

    expect(() => validateWorkingDirectory(NATIVE_DIR)).toThrow(/does not exist/)
    expect(wslUncDirectoryExistsMock).not.toHaveBeenCalled()
  })

  it('rejects a native Windows path that exists but is not a directory', () => {
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue(dirStats(false))

    expect(() => validateWorkingDirectory(NATIVE_DIR)).toThrow(/is not a directory/)
  })
})

describe('spawnShellWithFallback macOS TCC login wrapping', () => {
  let origPlatform: PropertyDescriptor | undefined

  beforeEach(() => {
    origPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue(dirStats(true))
    accessSyncMock.mockReturnValue(undefined)
    // Emulate the real wrapper: prepend /usr/bin/login in front of the shell.
    wrapSpawnMock.mockImplementation((file: string, args: string[]) => ({
      file: '/usr/bin/login',
      args: ['-flpq', 'ada', file, ...args]
    }))
  })

  afterEach(() => {
    if (origPlatform) {
      Object.defineProperty(process, 'platform', origPlatform)
    }
    vi.restoreAllMocks()
  })

  it('spawns the primary shell through the login wrapper', () => {
    const ptySpawn = vi.fn().mockReturnValue({ pid: 1 })

    const result = spawnShellWithFallback({
      shellPath: '/bin/zsh',
      shellArgs: ['-l'],
      cols: 80,
      rows: 24,
      cwd: '/work',
      env: {},
      ptySpawn: ptySpawn as never
    })

    expect(wrapSpawnMock).toHaveBeenCalledWith('/bin/zsh', ['-l'], expect.any(Object))
    expect(ptySpawn).toHaveBeenCalledWith(
      '/usr/bin/login',
      ['-flpq', 'ada', '/bin/zsh', '-l'],
      expect.objectContaining({ cwd: '/work', cols: 80, rows: 24 })
    )
    // The reported shellPath stays the real shell so identity/name logic is intact.
    expect(result.shellPath).toBe('/bin/zsh')
  })

  it('wraps fallback shells too when the primary fails to spawn', () => {
    const ptySpawn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('primary boom')
      })
      .mockReturnValue({ pid: 2 })

    const result = spawnShellWithFallback({
      shellPath: '/bin/zsh',
      shellArgs: ['-l'],
      cols: 80,
      rows: 24,
      cwd: '/work',
      env: {},
      ptySpawn: ptySpawn as never
    })

    // First fallback candidate after /bin/zsh is /bin/bash, also login-wrapped.
    // The wrapper must see the fallback-corrected env so SHELL survives login(1).
    expect(wrapSpawnMock).toHaveBeenLastCalledWith(
      '/bin/bash',
      ['-l'],
      expect.objectContaining({ SHELL: '/bin/bash' })
    )
    expect(ptySpawn).toHaveBeenLastCalledWith(
      '/usr/bin/login',
      ['-flpq', 'ada', '/bin/bash', '-l'],
      expect.objectContaining({ cwd: '/work' })
    )
    expect(result.shellPath).toBe('/bin/bash')
  })
})
