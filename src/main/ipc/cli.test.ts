import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as BackgroundDistroGate from '../wsl-background-distro-gate'

const {
  handlers,
  ipcHandleMock,
  wslInstallerMock,
  recordInstalledMock,
  recordRemovedMock,
  forgetMock,
  getDefaultWslDistroMock,
  readWslDistroRunningStateMock
} = vi.hoisted(() => ({
  readWslDistroRunningStateMock: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ipcHandleMock: vi.fn(),
  wslInstallerMock: vi.fn(),
  recordInstalledMock: vi.fn(),
  recordRemovedMock: vi.fn(),
  forgetMock: vi.fn(),
  getDefaultWslDistroMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: ipcHandleMock } }))
vi.mock('../cli/cli-installer', () => ({ CliInstaller: vi.fn() }))
vi.mock('../cli/wsl-cli-installer', () => ({ WslCliInstaller: wslInstallerMock }))
vi.mock('../cli/wsl-cli-registration-registry', () => ({
  recordWslCliRegistrationInstalled: recordInstalledMock,
  recordWslCliRegistrationRemoved: recordRemovedMock,
  forgetWslCliRegistration: forgetMock
}))
vi.mock('../persistence', () => ({ getCanonicalUserDataPath: () => '/canonical-user-data' }))
vi.mock('../startup/hydrate-shell-path', () => ({
  hydrateShellPath: vi.fn(async () => ({ ok: false })),
  mergePathSegments: vi.fn()
}))
vi.mock('../wsl', () => ({ getDefaultWslDistro: getDefaultWslDistroMock }))
vi.mock('../wsl-background-distro-gate', async (importOriginal) => ({
  ...(await importOriginal<typeof BackgroundDistroGate>()),
  readWslDistroRunningState: readWslDistroRunningStateMock
}))

import { registerCliHandlers } from './cli'
import { WslCliUnreachableError } from '../cli/wsl-cli-status'

type WslHandler = (
  event: unknown,
  args?: { distro?: string | null; wakeWslDistro?: boolean }
) => Promise<{ state: string }>

function getWslHandler(channel: string): WslHandler {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`Missing IPC handler: ${channel}`)
  }
  return handler as WslHandler
}

describe('WSL CLI registration IPC', () => {
  beforeEach(() => {
    handlers.clear()
    ipcHandleMock.mockReset()
    ipcHandleMock.mockImplementation(
      (channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }
    )
    wslInstallerMock.mockReset()
    recordInstalledMock.mockReset().mockResolvedValue(undefined)
    recordRemovedMock.mockReset().mockResolvedValue(undefined)
    forgetMock.mockReset().mockResolvedValue(undefined)
    getDefaultWslDistroMock.mockReset().mockReturnValue('Ubuntu')
    registerCliHandlers()
  })

  it('returns a retryable status instead of rejecting when the distro does not answer', async () => {
    const getStatus = vi.fn(async () => {
      throw new WslCliUnreachableError('Ubuntu')
    })
    wslInstallerMock.mockImplementation(function MockWslCliInstaller() {
      return { getStatus }
    })

    await expect(getWslHandler('cli:getWslInstallStatus')({})).resolves.toMatchObject({
      state: 'unsupported',
      supported: false,
      unsupportedReason: 'wsl_unreachable',
      detail: expect.stringContaining('refresh to try again')
    })
  })

  it('still rejects on WSL command failures that are not timeouts', async () => {
    const getStatus = vi.fn(async () => {
      throw new Error('permission denied')
    })
    wslInstallerMock.mockImplementation(function MockWslCliInstaller() {
      return { getStatus }
    })

    await expect(getWslHandler('cli:getWslInstallStatus')({})).rejects.toThrow('permission denied')
  })

  it('records a successful explicit-distro installation', async () => {
    const install = vi.fn(async () => ({ state: 'installed' }))
    wslInstallerMock.mockImplementation(function MockWslCliInstaller() {
      return { install }
    })

    await expect(getWslHandler('cli:installWsl')({}, { distro: ' Debian ' })).resolves.toEqual({
      state: 'installed'
    })
    expect(wslInstallerMock).toHaveBeenCalledWith({ distro: 'Debian' })
    expect(recordInstalledMock).toHaveBeenCalledWith('/canonical-user-data', 'Debian')
  })

  it('records removal from the resolved default distro', async () => {
    const remove = vi.fn(async () => ({ state: 'not_installed' }))
    wslInstallerMock.mockImplementation(function MockWslCliInstaller() {
      return { remove }
    })

    await expect(getWslHandler('cli:removeWsl')({})).resolves.toEqual({ state: 'not_installed' })
    expect(wslInstallerMock).toHaveBeenCalledWith({ distro: 'Ubuntu' })
    expect(recordRemovedMock).toHaveBeenCalledWith('/canonical-user-data', 'Ubuntu')
  })

  it('forgets the registration of a deleted distro instead of failing the removal', async () => {
    const remove = vi.fn(async () => {
      throw new Error('wsl.exe: There is no distribution with the supplied name.')
    })
    wslInstallerMock.mockImplementation(function MockWslCliInstaller() {
      return { remove }
    })

    await expect(
      getWslHandler('cli:removeWsl')({}, { distro: 'orca-uqa-1029' })
    ).resolves.toMatchObject({ state: 'not_installed', supported: false })
    expect(forgetMock).toHaveBeenCalledWith('/canonical-user-data', 'orca-uqa-1029')
    expect(recordRemovedMock).not.toHaveBeenCalled()
  })

  it('keeps the registration when removal fails for another reason', async () => {
    const remove = vi.fn(async () => {
      throw new Error('permission denied')
    })
    wslInstallerMock.mockImplementation(function MockWslCliInstaller() {
      return { remove }
    })

    await expect(getWslHandler('cli:removeWsl')({}, { distro: 'Ubuntu' })).rejects.toThrow(
      'permission denied'
    )
    expect(forgetMock).not.toHaveBeenCalled()
  })

  it('does not claim ownership when installation is not confirmed', async () => {
    const install = vi.fn(async () => ({ state: 'unsupported' }))
    wslInstallerMock.mockImplementation(function MockWslCliInstaller() {
      return { install }
    })

    await expect(getWslHandler('cli:installWsl')({})).resolves.toEqual({ state: 'unsupported' })
    expect(recordInstalledMock).not.toHaveBeenCalled()
  })

  it('keeps successful installation successful when advisory registry persistence fails', async () => {
    const install = vi.fn(async () => ({ state: 'installed' }))
    wslInstallerMock.mockImplementation(function MockWslCliInstaller() {
      return { install }
    })
    recordInstalledMock.mockRejectedValueOnce(new Error('ENOSPC'))

    await expect(getWslHandler('cli:installWsl')({})).resolves.toEqual({ state: 'installed' })
  })

  it('keeps successful removal successful when advisory registry persistence fails', async () => {
    const remove = vi.fn(async () => ({ state: 'not_installed' }))
    wslInstallerMock.mockImplementation(function MockWslCliInstaller() {
      return { remove }
    })
    recordRemovedMock.mockRejectedValueOnce(new Error('EACCES'))

    await expect(getWslHandler('cli:removeWsl')({})).resolves.toEqual({ state: 'not_installed' })
  })

  it('serializes a concurrent removal after installation and ownership persistence', async () => {
    let finishInstall!: () => void
    const install = vi.fn(
      () =>
        new Promise<{ state: 'installed' }>((resolve) => {
          finishInstall = () => resolve({ state: 'installed' })
        })
    )
    const remove = vi.fn(async () => ({ state: 'not_installed' as const }))
    wslInstallerMock
      .mockImplementationOnce(function MockInstallWslCliInstaller() {
        return { install }
      })
      .mockImplementationOnce(function MockRemoveWslCliInstaller() {
        return { remove }
      })

    const installation = getWslHandler('cli:installWsl')({}, { distro: 'Ubuntu' })
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce())
    const removal = getWslHandler('cli:removeWsl')({}, { distro: 'ubuntu' })
    await Promise.resolve()
    expect(remove).not.toHaveBeenCalled()

    finishInstall()
    await expect(installation).resolves.toEqual({ state: 'installed' })
    await expect(removal).resolves.toEqual({ state: 'not_installed' })
    expect(recordInstalledMock.mock.invocationCallOrder[0]).toBeLessThan(
      remove.mock.invocationCallOrder[0]
    )
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(
      recordRemovedMock.mock.invocationCallOrder[0]
    )
  })

  describe('on Windows (E9)', () => {
    const originalPlatform = process.platform
    const getStatus = vi.fn(async () => ({ state: 'installed' }))

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
      readWslDistroRunningStateMock.mockReset().mockResolvedValue('stopped')
      getStatus.mockClear()
      wslInstallerMock.mockImplementation(function MockWslCliInstaller() {
        return { getStatus }
      })
    })

    afterEach(() => {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    })

    it('shows a refreshable state instead of starting a stopped distro when Settings opens', async () => {
      await expect(getWslHandler('cli:getWslInstallStatus')({})).resolves.toMatchObject({
        state: 'unsupported',
        unsupportedReason: 'wsl_unreachable',
        detail: expect.stringContaining('Ubuntu) is not running')
      })
      expect(wslInstallerMock).not.toHaveBeenCalled()
    })

    it('lets the refresh button start the distro to read its status', async () => {
      await expect(
        getWslHandler('cli:getWslInstallStatus')({}, { wakeWslDistro: true })
      ).resolves.toEqual({ state: 'installed' })
      expect(getStatus).toHaveBeenCalledTimes(1)
    })

    it('reads a running distro exactly as before', async () => {
      readWslDistroRunningStateMock.mockResolvedValue('running')
      await expect(getWslHandler('cli:getWslInstallStatus')({})).resolves.toEqual({
        state: 'installed'
      })
    })
  })
})
