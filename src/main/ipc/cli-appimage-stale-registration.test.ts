import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallState, CliInstallStatus } from '../../shared/cli-install-types'

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  handle: vi.fn(),
  hydrateShellPath: vi.fn(),
  install: vi.fn(),
  isAppImageRegistrationOwnedBySibling: vi.fn(),
  mergePathSegments: vi.fn(),
  remove: vi.fn(),
  resolveAppImageCacheKey: vi.fn(),
  resolveAppImageRuntimeIdentity: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))

vi.mock('../cli/cli-installer', () => ({
  CliInstaller: class {
    getStatus = mocks.getStatus
    install = mocks.install
    isAppImageRegistrationOwnedBySibling = mocks.isAppImageRegistrationOwnedBySibling
    remove = mocks.remove
  }
}))

vi.mock('../appimage-runtime-identity', () => ({
  resolveAppImageRuntimeIdentity: mocks.resolveAppImageRuntimeIdentity
}))

vi.mock('../cli/appimage-extracted-root', () => ({
  resolveAppImageCacheKey: mocks.resolveAppImageCacheKey
}))

vi.mock('../cli/wsl-cli-installer', () => ({
  WslCliInstaller: class {
    getStatus = mocks.getStatus
    install = mocks.install
    remove = mocks.remove
  }
}))

vi.mock('../cli/wsl-cli-registration-registry', () => ({
  recordWslCliRegistrationInstalled: vi.fn(),
  recordWslCliRegistrationRemoved: vi.fn()
}))

vi.mock('../cli/wsl-cli-registration-operation', () => ({
  runSerializedWslCliRegistrationOperation: vi.fn()
}))

vi.mock('../persistence', () => ({ getCanonicalUserDataPath: vi.fn() }))

vi.mock('../startup/hydrate-shell-path', () => ({
  hydrateShellPath: mocks.hydrateShellPath,
  mergePathSegments: mocks.mergePathSegments
}))

vi.mock('../wsl', () => ({ getDefaultWslDistro: vi.fn() }))

import { registerCliHandlers } from './cli'

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function status(
  state: CliInstallState,
  launcherPath = '/cache/current/resources/bin/orca-ide'
): CliInstallStatus {
  return {
    platform: 'linux',
    commandName: 'orca-ide',
    commandPath: '/home/me/.local/bin/orca-ide',
    pathDirectory: '/home/me/.local/bin',
    pathConfigured: true,
    launcherPath,
    installMethod: 'symlink',
    supported: true,
    state,
    currentTarget: state === 'not_installed' ? null : '/cache/old/resources/bin/orca-ide',
    unsupportedReason: null,
    detail: null
  }
}

function installStatusHandler(): () => Promise<CliInstallStatus> {
  registerCliHandlers()
  return cliHandler('cli:getInstallStatus')
}

function cliHandler(channelName: string): () => Promise<CliInstallStatus> {
  const call = mocks.handle.mock.calls.find(([channel]) => channel === channelName)
  expect(call).toBeTruthy()
  return call![1]
}

beforeEach(() => {
  mocks.getStatus.mockReset()
  mocks.handle.mockReset()
  mocks.hydrateShellPath.mockReset().mockResolvedValue({ ok: false })
  mocks.install.mockReset()
  mocks.isAppImageRegistrationOwnedBySibling.mockReset().mockReturnValue(false)
  mocks.mergePathSegments.mockReset()
  mocks.remove.mockReset()
  mocks.resolveAppImageCacheKey.mockReset().mockReturnValue('generation-1')
  mocks.resolveAppImageRuntimeIdentity.mockReset().mockImplementation(() =>
    process.platform === 'linux'
      ? {
          appImagePath: '/opt/Orca.AppImage'
        }
      : null
  )
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  vi.stubEnv('APPIMAGE', '/opt/Orca.AppImage')
})

afterEach(() => {
  vi.unstubAllEnvs()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  vi.restoreAllMocks()
})

describe('AppImage CLI registration startup repair', () => {
  it('repairs a managed stale registration and returns the installed status', async () => {
    const stale = status('stale')
    const installed = status('installed')
    mocks.getStatus.mockResolvedValue(stale)
    mocks.install.mockResolvedValue(installed)

    await expect(installStatusHandler()()).resolves.toBe(installed)
    expect(mocks.install).toHaveBeenCalledOnce()
  })

  it('keeps the stale status when automatic repair fails', async () => {
    const stale = status('stale')
    mocks.getStatus.mockResolvedValue(stale)
    mocks.install.mockRejectedValue(new Error('read-only filesystem'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(installStatusHandler()()).resolves.toBe(stale)
    expect(warn).toHaveBeenCalledWith(
      '[cli] Failed to repair stale AppImage registration:',
      'read-only filesystem'
    )
  })

  it('retries a failed automatic repair after the cooldown', async () => {
    const stale = status('stale')
    const installed = status('installed')
    let now = 1_000
    mocks.getStatus.mockResolvedValue(stale)
    mocks.install
      .mockRejectedValueOnce(new Error('read-only filesystem'))
      .mockResolvedValueOnce(installed)
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handler = installStatusHandler()

    await expect(handler()).resolves.toBe(stale)
    await expect(handler()).resolves.toBe(stale)
    expect(mocks.install).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledOnce()

    now += 30_000
    await expect(handler()).resolves.toBe(installed)
    expect(mocks.install).toHaveBeenCalledTimes(2)
  })

  it('shares one automatic repair across concurrent status polls', async () => {
    const stale = status('stale')
    const installed = status('installed')
    let finishRepair: (result: CliInstallStatus) => void = () => {}
    const repair = new Promise<CliInstallStatus>((resolve) => {
      finishRepair = resolve
    })
    mocks.getStatus.mockResolvedValue(stale)
    mocks.install.mockReturnValue(repair)
    const handler = installStatusHandler()

    const first = handler()
    const second = handler()
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledOnce())
    finishRepair(installed)

    await expect(Promise.all([first, second])).resolves.toEqual([installed, installed])
  })

  it('repairs a later AppImage generation after an earlier repair succeeds', async () => {
    const firstStale = status('stale', '/cache/launcher/orca-ide')
    const firstInstalled = status('installed', '/cache/launcher/orca-ide')
    const nextStale = status('stale', '/cache/launcher/orca-ide')
    const nextInstalled = status('installed', '/cache/launcher/orca-ide')
    mocks.getStatus
      .mockResolvedValueOnce(firstStale)
      .mockResolvedValueOnce(firstStale)
      .mockResolvedValueOnce(nextStale)
      .mockResolvedValueOnce(nextStale)
    mocks.install.mockResolvedValueOnce(firstInstalled).mockResolvedValueOnce(nextInstalled)
    mocks.resolveAppImageCacheKey
      .mockReturnValueOnce('generation-1')
      .mockReturnValueOnce('generation-1')
      .mockReturnValueOnce('generation-2')
      .mockReturnValueOnce('generation-2')
    const handler = installStatusHandler()

    await expect(handler()).resolves.toBe(firstInstalled)
    await expect(handler()).resolves.toBe(nextInstalled)
    expect(mocks.install).toHaveBeenCalledTimes(2)
  })

  it('waits for the cooldown before repairing a newer AppImage generation', async () => {
    const firstStale = status('stale', '/cache/launcher/orca-ide')
    const nextStale = status('stale', '/cache/launcher/orca-ide')
    const nextInstalled = status('installed', '/cache/launcher/orca-ide')
    let now = 1_000
    mocks.getStatus
      .mockResolvedValueOnce(firstStale)
      .mockResolvedValueOnce(firstStale)
      .mockResolvedValueOnce(nextStale)
      .mockResolvedValueOnce(nextStale)
      .mockResolvedValueOnce(nextStale)
    mocks.install
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(nextInstalled)
    mocks.resolveAppImageCacheKey
      .mockReturnValueOnce('generation-1')
      .mockReturnValueOnce('generation-1')
      .mockReturnValueOnce('generation-2')
      .mockReturnValueOnce('generation-2')
      .mockReturnValueOnce('generation-2')
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handler = installStatusHandler()

    await expect(handler()).resolves.toBe(firstStale)
    await expect(handler()).resolves.toBe(nextStale)
    expect(mocks.install).toHaveBeenCalledOnce()

    now += 30_000
    await expect(handler()).resolves.toBe(nextInstalled)
    expect(mocks.install).toHaveBeenCalledTimes(2)
  })

  it('keeps the explicit install action retryable after automatic repair fails', async () => {
    const stale = status('stale')
    const installed = status('installed')
    mocks.getStatus.mockResolvedValue(stale)
    mocks.install
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(installed)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerCliHandlers()

    await expect(cliHandler('cli:getInstallStatus')()).resolves.toBe(stale)
    await expect(cliHandler('cli:install')()).resolves.toBe(installed)
    expect(mocks.install).toHaveBeenCalledTimes(2)
  })

  it('serializes concurrent explicit installs', async () => {
    const installed = status('installed')
    let finishFirstInstall: (result: CliInstallStatus) => void = () => {}
    const firstInstall = new Promise<CliInstallStatus>((resolve) => {
      finishFirstInstall = resolve
    })
    mocks.install.mockReturnValueOnce(firstInstall).mockResolvedValueOnce(installed)
    registerCliHandlers()
    const handler = cliHandler('cli:install')

    const first = handler()
    const second = handler()
    await vi.waitFor(() => expect(mocks.install).toHaveBeenCalledOnce())

    finishFirstInstall(installed)
    await expect(Promise.all([first, second])).resolves.toEqual([installed, installed])
    expect(mocks.install).toHaveBeenCalledTimes(2)
  })

  it('does not undo a queued removal with a stale automatic repair', async () => {
    const stale = status('stale')
    const notInstalled = status('not_installed')
    let finishRemove: (result: CliInstallStatus) => void = () => {}
    const removal = new Promise<CliInstallStatus>((resolve) => {
      finishRemove = resolve
    })
    mocks.getStatus.mockResolvedValueOnce(stale).mockResolvedValueOnce(notInstalled)
    mocks.remove.mockReturnValue(removal)
    registerCliHandlers()

    const remove = cliHandler('cli:remove')()
    await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce())
    const poll = cliHandler('cli:getInstallStatus')()
    finishRemove(notInstalled)

    await expect(remove).resolves.toBe(notInstalled)
    await expect(poll).resolves.toBe(notInstalled)
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('keys a queued repair cooldown to the generation it rechecks', async () => {
    const stale = status('stale')
    const notInstalled = status('not_installed')
    let finishRemove: (result: CliInstallStatus) => void = () => {}
    const removal = new Promise<CliInstallStatus>((resolve) => {
      finishRemove = resolve
    })
    mocks.getStatus.mockResolvedValue(stale)
    mocks.remove.mockReturnValue(removal)
    mocks.install.mockRejectedValue(new Error('temporary failure'))
    mocks.resolveAppImageCacheKey
      .mockReturnValueOnce('generation-1')
      .mockReturnValue('generation-2')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerCliHandlers()

    const remove = cliHandler('cli:remove')()
    await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce())
    const oldGenerationPoll = cliHandler('cli:getInstallStatus')()
    finishRemove(notInstalled)

    await expect(remove).resolves.toBe(notInstalled)
    await expect(oldGenerationPoll).resolves.toBe(stale)
    await expect(cliHandler('cli:getInstallStatus')()).resolves.toBe(stale)
    await expect(cliHandler('cli:getInstallStatus')()).resolves.toBe(stale)
    expect(mocks.install).toHaveBeenCalledOnce()
  })

  it.each(['conflict', 'not_installed'] as const)(
    'does not mutate a %s registration',
    async (state) => {
      const current = status(state)
      mocks.getStatus.mockResolvedValue(current)

      await expect(installStatusHandler()()).resolves.toBe(current)
      expect(mocks.install).not.toHaveBeenCalled()
    }
  )

  it('does not mutate a stale non-AppImage registration', async () => {
    const stale = status('stale')
    mocks.getStatus.mockResolvedValue(stale)
    mocks.resolveAppImageRuntimeIdentity.mockReturnValue(null)

    await expect(installStatusHandler()()).resolves.toBe(stale)
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('does not claim a sibling AppImage registration during a status poll', async () => {
    const stale = {
      ...status('stale'),
      currentTarget: '/cache/current/resources/bin/orca-ide'
    }
    mocks.getStatus.mockResolvedValue(stale)
    mocks.isAppImageRegistrationOwnedBySibling.mockReturnValue(true)

    await expect(installStatusHandler()()).resolves.toBe(stale)
    expect(mocks.install).not.toHaveBeenCalled()
  })

  it('migrates a legacy AppImage target even when a sibling owns the stable endpoint', async () => {
    const stale = status('stale')
    const installed = status('installed')
    mocks.getStatus.mockResolvedValue(stale)
    mocks.install.mockResolvedValue(installed)
    mocks.isAppImageRegistrationOwnedBySibling.mockImplementation(
      (current: CliInstallStatus) => current.currentTarget === current.launcherPath
    )

    await expect(installStatusHandler()()).resolves.toBe(installed)
    expect(mocks.install).toHaveBeenCalledOnce()
  })

  it('does not mutate a stale registration off Linux', async () => {
    const stale = status('stale')
    mocks.getStatus.mockResolvedValue(stale)
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' })

    await expect(installStatusHandler()()).resolves.toBe(stale)
    expect(mocks.install).not.toHaveBeenCalled()
  })
})
