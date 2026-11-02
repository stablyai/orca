import type { CliInstallStatus } from '../../shared/cli-install-types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())

vi.mock('../wsl/wsl-runner', () => ({
  runWslProcess: runWslProcessMock
}))

import { WslCliInstaller, _internals } from './wsl-cli-installer'
import { WslCliUnreachableError } from './wsl-cli-status'

// #14288 / #29497: which status calls pay the login-PATH probe, and how a slow
// distro or blocking ~/.profile is reported.

const launcherPath = 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\resources\\bin\\orca.exe'

function makeHostStatus(): CliInstallStatus {
  return {
    platform: 'win32',
    commandName: 'orca',
    commandPath: launcherPath,
    pathDirectory: 'C:\\Users\\me\\AppData\\Local\\Programs\\Orca\\resources\\bin',
    pathConfigured: true,
    launcherPath,
    installMethod: 'wrapper',
    supported: true,
    state: 'installed',
    currentTarget: launcherPath,
    unsupportedReason: null,
    detail: null
  }
}

describe('WslCliInstaller login-PATH lanes', () => {
  beforeEach(() => {
    runWslProcessMock.mockReset()
  })

  it('settles when wsl.exe never reports completion', async () => {
    // Why no fake timers: the timeout is now runProcess's own, internal to the
    // mocked runWslProcess -- there is nothing left here to advance.
    runWslProcessMock.mockResolvedValue({ code: null, stdout: '', stderr: '', timedOut: true })
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() }
    })

    await expect(installer.getStatus()).rejects.toBeInstanceOf(WslCliUnreachableError)
  })

  it('runs status file probes without the login-PATH probe, and only $PATH with it', async () => {
    runWslProcessMock.mockImplementation(async (spec: { script: string; loginPath: string }) => ({
      environmentResolved: true,
      code: 0,
      stdout: spec.script.includes('$HOME')
        ? '/home/alice'
        : spec.script.includes('wslpath') || spec.script.includes(':$PATH:')
          ? 'yes'
          : '__ORCA_MISSING__',
      stderr: '',
      timedOut: false
    }))
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() }
    })

    await expect(installer.getStatus()).resolves.toMatchObject({ state: 'not_installed' })
    const lanes = runWslProcessMock.mock.calls.map(([spec]) => ({
      pathProbe: spec.script.includes(':$PATH:'),
      loginPath: spec.loginPath
    }))
    // Why: a cold distro boots on the first call; a login probe there took half
    // its 10s budget and timed the status check out (#29497).
    expect(lanes.filter((lane) => lane.loginPath === 'preferred')).toEqual([
      { pathProbe: true, loginPath: 'preferred' }
    ])
    expect(lanes.filter((lane) => !lane.pathProbe).every((l) => l.loginPath === 'none')).toBe(true)
  })

  it('reports PATH unknown rather than "not on PATH" without the login PATH', async () => {
    // The `case ":$PATH:"` probe answers from the distro default PATH when the
    // login PATH never resolved, and ~/.local/bin is never on that. Settings
    // would then state as fact that the CLI is not on PATH while the user's
    // own terminal finds it -- #14288 turning into a confident wrong verdict.
    // A blocking ~/.profile must not hide the file state either: report the
    // registration with PATH unknown (null), never "not on PATH".
    const launcher = _internals.buildWslLauncher(
      launcherPath,
      '/home/alice/.local/share/orca/orca-wsl-bridge.ps1'
    )
    runWslProcessMock.mockImplementation(async (spec: { script: string; loginPath: string }) => ({
      environmentResolved: spec.loginPath !== 'preferred',
      code: 0,
      stdout: spec.script.includes('$HOME')
        ? '/home/alice'
        : spec.script.includes(':$PATH:')
          ? 'no'
          : spec.script.includes('wslpath')
            ? 'yes'
            : spec.script.includes('orca-wsl-bridge.ps1')
              ? _internals.buildWslBridgeScript()
              : launcher,
      stderr: '',
      timedOut: false
    }))
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() }
    })

    const status = await installer.getStatus()
    expect(status).toMatchObject({ state: 'installed', pathConfigured: null })
    expect(status.detail).toContain('login PATH could not be read')
  })

  it('reports PATH unknown when only the login-PATH check times out', async () => {
    runWslProcessMock.mockImplementation(async (spec: { script: string }) => ({
      environmentResolved: true,
      code: spec.script.includes(':$PATH:') ? null : 0,
      stdout: spec.script.includes('$HOME')
        ? '/home/alice'
        : spec.script.includes('wslpath')
          ? 'yes'
          : '__ORCA_MISSING__',
      stderr: '',
      timedOut: spec.script.includes(':$PATH:')
    }))
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() }
    })

    await expect(installer.getStatus()).resolves.toMatchObject({
      state: 'not_installed',
      pathConfigured: null
    })
  })

  it('installs without the login PATH so a blocking ~/.profile cannot block registration', async () => {
    const files = new Map<string, string>()
    runWslProcessMock.mockImplementation(async (spec: { script: string; loginPath: string }) => ({
      environmentResolved: spec.loginPath !== 'preferred',
      code: 0,
      // Install first: its launcher payload also mentions wslpath.
      stdout: spec.script.includes('cat > "$command_tmp"')
        ? (files.set('installed', 'yes'), '')
        : spec.script.includes('$HOME')
          ? '/home/alice'
          : spec.script.includes('wslpath')
            ? 'yes'
            : '__ORCA_MISSING__',
      stderr: '',
      timedOut: false
    }))
    const installer = new WslCliInstaller({
      platform: 'win32',
      distro: 'Ubuntu',
      hostInstaller: { getStatus: async () => makeHostStatus() }
    })

    await installer.install()
    expect(files.get('installed')).toBe('yes')
    const installCall = runWslProcessMock.mock.calls.find(([spec]) =>
      spec.script.includes('cat > "$command_tmp"')
    )
    expect(installCall?.[0].loginPath).toBe('none')
  })
})
