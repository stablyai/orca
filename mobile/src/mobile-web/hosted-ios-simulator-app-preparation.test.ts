import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  buildAndInstall: vi.fn(),
  install: vi.fn()
}))

vi.mock('../../scripts/hosted-ios-simulator-app-build.mjs', () => ({
  buildAndInstallHostedIosSimulatorApp: mocks.buildAndInstall,
  hostedIosSimulatorAppPath: (worktree: string) => `${worktree}/Orca.app`,
  installHostedIosSimulatorApp: mocks.install
}))

import { hostedIosSimulatorAppPreparation } from '../../scripts/hosted-ios-simulator-app-preparation.mjs'

describe('hosted iOS simulator app preparation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.buildAndInstall.mockResolvedValue('/worktree/Orca.app')
    mocks.install.mockResolvedValue(undefined)
  })

  it('reuses the installed app without reinstalling it', async () => {
    const runCommand = vi.fn().mockResolvedValue({ stdout: '/installed/Orca.app' })
    const preparation = hostedIosSimulatorAppPreparation({
      deviceUdid: 'simulator',
      reuseNativeInstall: true,
      skipNativeBuild: false,
      worktree: '/worktree',
      runCommand
    })

    await expect(preparation.run()).resolves.toBe('/installed/Orca.app')
    expect(preparation.label).toBe('existing native simulator app')
    expect(runCommand).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'get_app_container',
      'simulator',
      'com.stably.orca.mobile',
      'app'
    ])
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('retains the cached reinstall and build paths', async () => {
    const cached = hostedIosSimulatorAppPreparation({
      deviceUdid: 'simulator',
      reuseNativeInstall: false,
      skipNativeBuild: true,
      worktree: '/worktree'
    })
    const build = hostedIosSimulatorAppPreparation({
      deviceUdid: 'simulator',
      reuseNativeInstall: false,
      skipNativeBuild: false,
      worktree: '/worktree'
    })

    await expect(cached.run()).resolves.toBe('/worktree/Orca.app')
    await expect(build.run()).resolves.toBe('/worktree/Orca.app')
    expect(mocks.install).toHaveBeenCalledWith({
      deviceUdid: 'simulator',
      appPath: '/worktree/Orca.app',
      runCommand: expect.any(Function)
    })
    expect(mocks.buildAndInstall).toHaveBeenCalledWith({
      deviceUdid: 'simulator',
      worktree: '/worktree',
      runCommand: expect.any(Function)
    })
  })
})
