import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  prepareManagedCodexHomeBeforeShellLaunch,
  resolveManagedCodexShellPreflightHome
} from './managed-home-shell-preflight'

const roots: string[] = []

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-shell-preflight-'))
  roots.push(root)
  return root
}

afterEach(() => {
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
