import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as fs from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import type { Stats } from 'node:fs'

const {
  existsSyncMock,
  statSyncMock,
  statMock,
  accessSyncMock,
  wslUncDirectoryExistsAsyncMock,
  wrapSpawnMock
} = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
  statMock: vi.fn(),
  accessSyncMock: vi.fn(),
  wslUncDirectoryExistsAsyncMock: vi.fn(),
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

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statMock
}))

function dirStats(isDirectory: boolean): Stats {
  return { isDirectory: () => isDirectory } as Stats
}

vi.mock('../wsl', () => ({
  wslUncDirectoryExistsAsync: wslUncDirectoryExistsAsyncMock
}))

vi.mock('./macos-tcc-login-shell', () => ({
  wrapShellSpawnForMacosTccAttribution: wrapSpawnMock,
  hostReportsChildExitStatus: (file: string) => file !== '/usr/bin/login'
}))

import {
  resolveUnixShellPath,
  spawnShellWithFallback,
  validateWorkingDirectory
} from './local-pty-utils'
import { _resetWorkingDirectoryValidationStateForTest } from './working-directory-validation'
import { getFishXdgDataDirsLaunchEnv } from '../fish-xdg-data-dirs-handoff'

const WSL_UNC_DIR = '\\\\wsl.localhost\\Ubuntu\\home\\jin\\repo'
const NATIVE_DIR = 'C:\\Users\\jin\\repo'

describe('validateWorkingDirectory', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    statSyncMock.mockReset()
    statMock.mockReset()
    wslUncDirectoryExistsAsyncMock.mockReset()
    _resetWorkingDirectoryValidationStateForTest()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('accepts a WSL UNC worktree that exists inside the distro even when fs.statSync would fail', async () => {
    // Why: the Win32 9P stat is the exact path that falsely reported ENOENT and
    // broke opening WSL worktrees. The distro answer must win.
    wslUncDirectoryExistsAsyncMock.mockResolvedValue(true)
    existsSyncMock.mockReturnValue(false)

    await expect(validateWorkingDirectory(WSL_UNC_DIR)).resolves.toBeUndefined()
    expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledWith(WSL_UNC_DIR)
    // The fs fallback must not run when the distro confirmed existence.
    expect(existsSyncMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
  })

  it('returns to the event loop while the distro probe is still running', async () => {
    const probe = Promise.withResolvers<boolean | null>()
    wslUncDirectoryExistsAsyncMock.mockReturnValue(probe.promise)
    let settled = false

    const validation = validateWorkingDirectory(WSL_UNC_DIR).finally(() => {
      settled = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(settled).toBe(false)

    probe.resolve(true)
    await validation
    expect(settled).toBe(true)
  })

  it('rejects a WSL UNC worktree that does not exist inside the distro', async () => {
    wslUncDirectoryExistsAsyncMock.mockResolvedValue(false)

    await expect(validateWorkingDirectory(WSL_UNC_DIR)).rejects.toThrow(/does not exist/)
    expect(existsSyncMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
  })

  it('falls back to the fs check when the distro answer is inconclusive', async () => {
    wslUncDirectoryExistsAsyncMock.mockResolvedValue(null)
    statMock.mockResolvedValue(dirStats(true))

    await expect(validateWorkingDirectory(WSL_UNC_DIR)).resolves.toBeUndefined()
    expect(wslUncDirectoryExistsAsyncMock).toHaveBeenCalledWith(WSL_UNC_DIR)
    expect(statMock).toHaveBeenCalledWith(WSL_UNC_DIR)
    expect(existsSyncMock).not.toHaveBeenCalled()
  })

  it('validates native Windows paths via fs without consulting the distro', async () => {
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue(dirStats(true))

    await expect(validateWorkingDirectory(NATIVE_DIR)).resolves.toBeUndefined()
    expect(wslUncDirectoryExistsAsyncMock).not.toHaveBeenCalled()
    expect(existsSyncMock).toHaveBeenCalledWith(NATIVE_DIR)
  })

  it('rejects a missing native Windows path', async () => {
    existsSyncMock.mockReturnValue(false)
    const previousVersion = process.env.ORCA_APP_VERSION
    process.env.ORCA_APP_VERSION = '1.4.178-test'

    try {
      await expect(validateWorkingDirectory(NATIVE_DIR)).rejects.toThrow(
        /does not exist.*orca: 1\.4\.178-test/
      )
      expect(wslUncDirectoryExistsAsyncMock).not.toHaveBeenCalled()
    } finally {
      if (previousVersion === undefined) {
        delete process.env.ORCA_APP_VERSION
      } else {
        process.env.ORCA_APP_VERSION = previousVersion
      }
    }
  })

  it('rejects a native Windows path that exists but is not a directory', async () => {
    existsSyncMock.mockReturnValue(true)
    statSyncMock.mockReturnValue(dirStats(false))

    await expect(validateWorkingDirectory(NATIVE_DIR)).rejects.toThrow(/is not a directory/)
  })
})

describe('resolveUnixShellPath', () => {
  beforeEach(() => {
    existsSyncMock.mockReset()
    accessSyncMock.mockReset()
  })

  it('preserves non-absolute shells for execvp PATH and cwd resolution', () => {
    expect(resolveUnixShellPath('bash')).toBe('bash')
    expect(resolveUnixShellPath('./bin/custom-shell')).toBe('./bin/custom-shell')
    expect(existsSyncMock).not.toHaveBeenCalled()
  })

  it('selects an executable fallback before node-pty can fork a missing shell', () => {
    existsSyncMock.mockImplementation((path) => path === '/bin/sh')
    accessSyncMock.mockReturnValue(undefined)

    expect(resolveUnixShellPath('/missing/zsh')).toBe('/bin/sh')
    expect(existsSyncMock.mock.calls.map(([path]) => path)).toEqual([
      '/missing/zsh',
      '/bin/zsh',
      '/bin/bash',
      '/bin/sh'
    ])
  })

  it('reports every attempted shell when no executable candidate exists', () => {
    existsSyncMock.mockReturnValue(false)

    expect(() => resolveUnixShellPath('/missing/zsh')).toThrow(
      'No executable Unix shell found (tried: /missing/zsh, /bin/zsh, /bin/bash, /bin/sh)'
    )
  })

  it('dedupes a preferred shell that is already a fallback candidate', () => {
    existsSyncMock.mockImplementation((path) => path === '/bin/sh')
    accessSyncMock.mockReturnValue(undefined)

    expect(resolveUnixShellPath('/bin/sh')).toBe('/bin/sh')
    expect(existsSyncMock.mock.calls.map(([path]) => path)).toEqual(['/bin/sh'])
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
    wrapSpawnMock.mockImplementation((file: string, args: string[]) => ({
      file: '/wrapped/login',
      args: ['wrapped', file, ...args]
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
      '/wrapped/login',
      ['wrapped', '/bin/zsh', '-l'],
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
      '/wrapped/login',
      ['wrapped', '/bin/bash', '-l'],
      expect.objectContaining({ cwd: '/work' })
    )
    expect(result.shellPath).toBe('/bin/bash')
  })

  it('drops the primary shell’s launch env when an unwrapped fallback takes over', () => {
    // Why: nothing in an unwrapped bash pane consumes the feature channel, so a
    // leftover ZDOTDIR would point a nested zsh at Orca's wrapper and turn on
    // features Orca never selected for it.
    const zshLaunchEnv = {
      ZDOTDIR: '/userdata/shell-ready/zsh',
      ORCA_ORIG_ZDOTDIR: '/home/jin',
      ORCA_SHELL_FEATURES: 'history'
    }
    const env: Record<string, string> = { HOME: '/home/jin', ...zshLaunchEnv }
    const ptySpawn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('primary boom')
      })
      .mockReturnValue({ pid: 3 })

    spawnShellWithFallback({
      shellPath: '/bin/zsh',
      shellArgs: ['-l'],
      cols: 80,
      rows: 24,
      cwd: '/work',
      env,
      ptySpawn: ptySpawn as never,
      preLaunchEnv: {
        ZDOTDIR: undefined,
        ORCA_ORIG_ZDOTDIR: undefined,
        ORCA_SHELL_FEATURES: undefined
      },
      getShellReadyConfig: (shell) =>
        shell === '/bin/zsh' ? { args: ['-l'], env: zshLaunchEnv } : { args: null, env: {} }
    })

    expect(env.ORCA_SHELL_FEATURES).toBeUndefined()
    expect(env.ZDOTDIR).toBeUndefined()
    expect(env.ORCA_ORIG_ZDOTDIR).toBeUndefined()
    expect(env.HOME).toBe('/home/jin')
  })

  it.each<[string, Record<string, string>, Record<string, string>]>([
    [
      '/opt/homebrew/bin/fish',
      { XDG_DATA_DIRS: '/opt/a:/opt/b' },
      getFishXdgDataDirsLaunchEnv('/userdata/wrappers', '/opt/a:/opt/b')
    ],
    [
      '/bin/zsh',
      { ZDOTDIR: '/home/jin/.zsh' },
      { ZDOTDIR: '/userdata/shell-ready/zsh', ORCA_SHELL_FEATURES: 'history' }
    ]
  ])('hands back the user’s own env when %s falls back', (shellPath, userEnv, launchEnv) => {
    const preLaunchEnv = Object.fromEntries(
      Object.keys(launchEnv).map((key) => [key, userEnv[key]])
    )
    const env: Record<string, string> = { HOME: '/home/jin', ...userEnv, ...launchEnv }
    const ptySpawn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('primary boom')
      })
      .mockReturnValue({ pid: 5 })

    const result = spawnShellWithFallback({
      shellPath,
      shellArgs: ['-l'],
      cols: 80,
      rows: 24,
      cwd: '/work',
      env,
      ptySpawn: ptySpawn as never,
      preLaunchEnv,
      getShellReadyConfig: () => ({ args: null, env: {} })
    })

    expect(env).toEqual({ HOME: '/home/jin', SHELL: result.shellPath, ...userEnv })
  })

  it('drops the first fallback’s launch env when a second fallback takes over', () => {
    // Why: the keys to scrub are the ones the LAST attempt wrote. Computed once
    // from the primary, a wrapped first fallback leaks its own ZDOTDIR and
    // feature channel into the shell that finally starts.
    const bashLaunchEnv = { ORCA_SHELL_FEATURES: 'markers', BASH_ENV: '/userdata/bash/rcfile' }
    const env: Record<string, string> = { HOME: '/home/jin', ZDOTDIR: '/userdata/shell-ready/zsh' }
    const ptySpawn = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('primary boom')
      })
      .mockImplementationOnce(() => {
        throw new Error('first fallback boom')
      })
      .mockReturnValue({ pid: 4 })

    spawnShellWithFallback({
      shellPath: '/bin/zsh',
      shellArgs: ['-l'],
      cols: 80,
      rows: 24,
      cwd: '/work',
      env,
      ptySpawn: ptySpawn as never,
      preLaunchEnv: { ZDOTDIR: undefined },
      getShellReadyConfig: (shell) =>
        shell === '/bin/bash' ? { args: ['--rcfile', '/rc'], env: bashLaunchEnv } : null
    })

    expect(env.ORCA_SHELL_FEATURES).toBeUndefined()
    expect(env.BASH_ENV).toBeUndefined()
    expect(env.ZDOTDIR).toBeUndefined()
    expect(env.HOME).toBe('/home/jin')
  })
})
