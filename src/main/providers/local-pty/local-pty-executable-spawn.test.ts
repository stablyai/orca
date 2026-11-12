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

vi.mock('../../wsl/filesystem/unc-path-access', () => ({
  wslUncDirectoryExistsAsync: wslUncDirectoryExistsAsyncMock
}))

vi.mock('../macos-tcc-login-shell', () => ({
  wrapShellSpawnForMacosTccAttribution: wrapSpawnMock,
  hostReportsChildExitStatus: (file: string) => file !== '/usr/bin/login'
}))
import { spawnShellWithFallback } from './local-pty-executable-spawn'
import { _resetWorkingDirectoryValidationStateForTest } from '../working-directory-validation'

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

  it('drops the first fallback’s launch env when a second fallback takes over', () => {
    // Scrub the last attempt keys; a once-only primary scrub would leak the first fallback env.
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
