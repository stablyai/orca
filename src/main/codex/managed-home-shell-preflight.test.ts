import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { wslRealpathMock } = vi.hoisted(() => ({
  wslRealpathMock: vi.fn(async (path: string) => path)
}))

vi.mock('node:fs/promises', () => ({ realpath: wslRealpathMock }))

import {
  prepareManagedCodexHomeBeforeShellLaunch,
  resolveManagedCodexShellPreflightHome
} from './managed-home-shell-preflight'
import {
  prepareManagedWslCodexHomeBeforeShellLaunch,
  resolveManagedWslCodexShellPreflightTarget
} from './managed-wsl-home-shell-preflight'
import {
  _internals as managedWslHomeRegistryInternals,
  recordManagedWslCodexHome
} from './managed-wsl-codex-home-registry'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-shell-preflight-'))
  roots.push(root)
  return root
}

afterEach(() => {
  wslRealpathMock.mockClear()
  managedWslHomeRegistryInternals.clearRecordedManagedWslCodexHomes()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('managed Codex shell preflight', () => {
  it('accepts the Orca shared runtime home', () => {
    const userDataPath = makeRoot()
    const home = join(userDataPath, 'codex-runtime-home', 'home')
    mkdirSync(home, { recursive: true })

    expect(
      resolveManagedCodexShellPreflightHome(
        { CODEX_HOME: home, ORCA_CODEX_HOME: home },
        userDataPath
      )
    ).toBe(home)
  })

  it('accepts a marker-proven account home and installs only while hooks are enabled', async () => {
    const userDataPath = makeRoot()
    const home = join(userDataPath, 'codex-accounts', 'account-1', 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, '.orca-managed-home'), 'account-1\n')
    const install = vi.fn(() => ({
      agent: 'codex' as const,
      state: 'installed' as const,
      configPath: join(home, 'hooks.json'),
      managedHooksPresent: true,
      detail: null
    }))
    const env = { CODEX_HOME: home, ORCA_CODEX_HOME: home }

    expect(
      await prepareManagedCodexHomeBeforeShellLaunch({
        userDataPath,
        hooksEnabled: true,
        env,
        install
      })
    ).toMatchObject({ state: 'installed' })
    expect(install).toHaveBeenCalledWith(home)

    expect(
      await prepareManagedCodexHomeBeforeShellLaunch({
        userDataPath,
        hooksEnabled: false,
        env,
        install
      })
    ).toBeNull()
    expect(install).toHaveBeenCalledTimes(1)
  })

  it('rejects user-owned homes and mismatched shell routing markers', () => {
    const userDataPath = makeRoot()
    const userHome = join(userDataPath, 'user-codex-home')
    const managedHome = join(userDataPath, 'codex-runtime-home', 'home')
    mkdirSync(userHome, { recursive: true })
    mkdirSync(managedHome, { recursive: true })

    expect(
      resolveManagedCodexShellPreflightHome(
        { CODEX_HOME: userHome, ORCA_CODEX_HOME: userHome },
        userDataPath
      )
    ).toBeNull()
    expect(
      resolveManagedCodexShellPreflightHome(
        { CODEX_HOME: userHome, ORCA_CODEX_HOME: managedHome },
        userDataPath
      )
    ).toBeNull()
    expect(
      resolveManagedCodexShellPreflightHome(
        { CODEX_HOME: managedHome, ORCA_CODEX_HOME: undefined },
        userDataPath
      )
    ).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('rejects a shared-home symlink escape', () => {
    const userDataPath = makeRoot()
    const outside = makeRoot()
    mkdirSync(join(userDataPath, 'codex-runtime-home'))
    symlinkSync(outside, join(userDataPath, 'codex-runtime-home', 'home'))
    const candidate = join(userDataPath, 'codex-runtime-home', 'home')

    expect(
      resolveManagedCodexShellPreflightHome(
        { CODEX_HOME: candidate, ORCA_CODEX_HOME: candidate },
        userDataPath
      )
    ).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('rejects an account-home symlink escape', () => {
    const userDataPath = makeRoot()
    const outside = makeRoot()
    const accountDir = join(userDataPath, 'codex-accounts', 'account-1')
    mkdirSync(accountDir, { recursive: true })
    writeFileSync(join(outside, '.orca-managed-home'), 'account-1\n')
    symlinkSync(outside, join(accountDir, 'home'))
    const candidate = join(accountDir, 'home')

    expect(
      resolveManagedCodexShellPreflightHome(
        { CODEX_HOME: candidate, ORCA_CODEX_HOME: candidate },
        userDataPath
      )
    ).toBeNull()
  })

  it('rejects a parent traversal account marker', () => {
    const userDataPath = makeRoot()
    const candidate = join(userDataPath, 'home')
    mkdirSync(join(userDataPath, 'codex-accounts'))
    mkdirSync(candidate)
    writeFileSync(join(candidate, '.orca-managed-home'), '..\n')

    expect(
      resolveManagedCodexShellPreflightHome(
        { CODEX_HOME: candidate, ORCA_CODEX_HOME: candidate },
        userDataPath
      )
    ).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('rejects a symlinked accounts root', () => {
    const userDataPath = makeRoot()
    const outside = makeRoot()
    const candidate = join(userDataPath, 'codex-accounts', 'account-1', 'home')
    mkdirSync(join(outside, 'account-1', 'home'), { recursive: true })
    writeFileSync(join(outside, 'account-1', 'home', '.orca-managed-home'), 'account-1\n')
    symlinkSync(outside, join(userDataPath, 'codex-accounts'))

    expect(
      resolveManagedCodexShellPreflightHome(
        { CODEX_HOME: candidate, ORCA_CODEX_HOME: candidate },
        userDataPath
      )
    ).toBeNull()
  })
})

describe('managed WSL Codex shell preflight', () => {
  const home = '/home/jin/.local/share/orca/codex-runtime-home/home'
  const runtimeHome =
    '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\.local\\share\\orca\\codex-runtime-home\\home'
  const env = {
    CODEX_HOME: home,
    ORCA_CODEX_HOME: home,
    WSL_DISTRO_NAME: 'Ubuntu-24.04'
  }

  it('targets the pane-selected managed home through its UNC twin', () => {
    recordManagedWslCodexHome('Ubuntu-24.04', runtimeHome)
    expect(resolveManagedWslCodexShellPreflightTarget(env)).toEqual({
      runtimeHomePath: runtimeHome,
      wslDistro: 'Ubuntu-24.04'
    })
  })

  it('reconstructs a validated managed home when a restarted runtime has no record', () => {
    expect(resolveManagedWslCodexShellPreflightTarget(env)).toEqual({
      runtimeHomePath: runtimeHome,
      wslDistro: 'Ubuntu-24.04'
    })
  })

  it('installs once through the WSL runtime-home lane while hooks are enabled', async () => {
    recordManagedWslCodexHome('Ubuntu-24.04', runtimeHome)
    const status = {
      agent: 'codex' as const,
      state: 'installed' as const,
      configPath: 'config.toml',
      managedHooksPresent: true,
      detail: null
    }
    const install = vi.fn(() => status)

    await expect(
      prepareManagedWslCodexHomeBeforeShellLaunch({ env, hooksEnabled: true, install })
    ).resolves.toBe(status)
    expect(install).toHaveBeenCalledExactlyOnceWith(runtimeHome, {
      runtime: 'wsl',
      wslDistro: 'Ubuntu-24.04'
    })

    await expect(
      prepareManagedWslCodexHomeBeforeShellLaunch({ env, hooksEnabled: false, install })
    ).resolves.toBeNull()
    expect(install).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      'a user home',
      { ...env, CODEX_HOME: '/home/jin/.codex', ORCA_CODEX_HOME: '/home/jin/.codex' }
    ],
    ['unequal routing markers', { ...env, ORCA_CODEX_HOME: `${home}-other` }],
    [
      'a parent traversal',
      {
        ...env,
        CODEX_HOME: `/home/jin/../jin${home.slice('/home/jin'.length)}`,
        ORCA_CODEX_HOME: `/home/jin/../jin${home.slice('/home/jin'.length)}`
      }
    ],
    [
      'a dot segment',
      {
        ...env,
        CODEX_HOME: `/home/./jin${home.slice('/home/jin'.length)}`,
        ORCA_CODEX_HOME: `/home/./jin${home.slice('/home/jin'.length)}`
      }
    ],
    [
      'a host path',
      { ...env, CODEX_HOME: 'C:\\Users\\jin\\.codex', ORCA_CODEX_HOME: 'C:\\Users\\jin\\.codex' }
    ],
    ['a missing distro', { ...env, WSL_DISTRO_NAME: '' }],
    ['a distro path escape', { ...env, WSL_DISTRO_NAME: 'Ubuntu\\..\\host' }],
    [
      'a repeated separator',
      {
        ...env,
        CODEX_HOME: home.replace('/jin/', '/jin//'),
        ORCA_CODEX_HOME: home.replace('/jin/', '/jin//')
      }
    ]
  ])('rejects %s', (_label, candidate) => {
    recordManagedWslCodexHome('Ubuntu-24.04', runtimeHome)
    expect(resolveManagedWslCodexShellPreflightTarget(candidate)).toBeNull()
  })

  it('preserves a recorded runtime spelling for a managed account home', () => {
    const directHome = '/home/jin/.local/share/orca/codex-accounts/account-1/home'
    const directRuntimeHome =
      '\\\\wsl$\\Ubuntu-24.04\\home\\jin\\.local\\share\\orca\\codex-accounts\\account-1\\home'
    recordManagedWslCodexHome('Ubuntu-24.04', directRuntimeHome)

    expect(
      resolveManagedWslCodexShellPreflightTarget({
        CODEX_HOME: directHome,
        ORCA_CODEX_HOME: directHome,
        WSL_DISTRO_NAME: 'ubuntu-24.04'
      })
    ).toEqual({ runtimeHomePath: directRuntimeHome, wslDistro: 'ubuntu-24.04' })
  })

  it('never authorizes a WSL system home even when it was offered by a PTY lane', () => {
    const systemHome = '/home/jin/.codex'
    recordManagedWslCodexHome('Ubuntu-24.04', '\\\\wsl.localhost\\Ubuntu-24.04\\home\\jin\\.codex')

    expect(
      resolveManagedWslCodexShellPreflightTarget({
        CODEX_HOME: systemHome,
        ORCA_CODEX_HOME: systemHome,
        WSL_DISTRO_NAME: 'Ubuntu-24.04'
      })
    ).toBeNull()
  })
})
