import type { CliInstallStatus } from '../../shared/cli-install-types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const runWslProcessMock = vi.hoisted(() => vi.fn())

vi.mock('../wsl/wsl-runner', () => ({
  runWslProcess: runWslProcessMock
}))

import { WslCliInstaller, _internals } from './wsl-cli-installer'

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

  it('reports PATH unknown rather than "not on PATH" without the login PATH', async () => {
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
})
