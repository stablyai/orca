import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installFakeAppEnvironment } from '../../../config/scripts/vitest-host-ports-setup'

const shim = vi.hoisted(() => ({ ensureLinuxTerminalOrcaCliShimDir: vi.fn() }))
vi.mock('./linux-terminal-orca-cli-shim', () => shim)

import { prependOrcaCliDirToChildPath } from './orca-cli-child-path'

const USER_DATA = '/data/orca'
const SHIM_DIR = join(USER_DATA, 'linux-orca-cli-shim')

beforeEach(() => {
  installFakeAppEnvironment()
  shim.ensureLinuxTerminalOrcaCliShimDir.mockReset()
  shim.ensureLinuxTerminalOrcaCliShimDir.mockReturnValue(SHIM_DIR)
})

afterEach(() => installFakeAppEnvironment())

describe('prependOrcaCliDirToChildPath', () => {
  it.each(['linux', 'darwin'] as const)(
    'uses the %s execution host CLI and profile over inherited values',
    (platform) => {
      const launcher = join(USER_DATA, 'cli', 'bin', 'orca')
      installFakeAppEnvironment({ getCliLauncherPath: () => launcher })
      const env: Record<string, string> = {
        PATH: `/usr/bin:${join(USER_DATA, 'cli', 'bin')}::/bin`,
        ORCA_USER_DATA_PATH: '/parent/profile',
        ORCA_CLI_COMMAND: '/parent/orca',
        ORCA_CLI_BIN_DIR: '/parent/bin'
      }
      expect(
        prependOrcaCliDirToChildPath(env, {
          isPackaged: true,
          userDataPath: USER_DATA,
          resourcesPath: null,
          platform
        })
      ).toBe(launcher)
      expect(env.PATH).toBe(`${join(USER_DATA, 'cli', 'bin')}:/usr/bin:/bin`)
      expect(env.ORCA_USER_DATA_PATH).toBe(USER_DATA)
      expect(env.ORCA_CLI_COMMAND).toBe(launcher)
      expect(env.ORCA_CLI_BIN_DIR).toBe(join(USER_DATA, 'cli', 'bin'))
      expect(shim.ensureLinuxTerminalOrcaCliShimDir).not.toHaveBeenCalled()
    }
  )
  it('puts a Windows execution host CLI first on Path without a POSIX restore dir', () => {
    const binDir = join(USER_DATA, 'cli', 'bin')
    const launcher = join(binDir, 'orca.exe')
    installFakeAppEnvironment({ getCliLauncherPath: () => launcher })
    const env: Record<string, string> = {
      Path: `C:\\Windows;${binDir};;C:\\Tools`,
      ORCA_USER_DATA_PATH: 'C:\\parent\\profile',
      ORCA_CLI_COMMAND: 'C:\\parent\\orca.exe',
      ORCA_CLI_BIN_DIR: '/parent/bin'
    }
    expect(
      prependOrcaCliDirToChildPath(env, {
        isPackaged: true,
        userDataPath: USER_DATA,
        resourcesPath: null,
        platform: 'win32'
      })
    ).toBe(launcher)
    expect(env).toEqual({
      Path: `${binDir};C:\\Windows;C:\\Tools`,
      ORCA_USER_DATA_PATH: USER_DATA,
      ORCA_CLI_COMMAND: launcher
    })
  })

  it('writes no trailing delimiter when nothing was inherited', () => {
    const env: Record<string, string> = { PATH: '' }
    const inheritedPath = process.env.PATH
    delete process.env.PATH
    try {
      prependOrcaCliDirToChildPath(env, {
        isPackaged: false,
        userDataPath: USER_DATA,
        platform: 'linux'
      })
    } finally {
      if (inheritedPath !== undefined) {
        process.env.PATH = inheritedPath
      }
    }
    // Why: an empty trailing segment resolves as `.` in some shells.
    expect(env.PATH).toBe(join(USER_DATA, 'cli', 'bin'))
  })
})
