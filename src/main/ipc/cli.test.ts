import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handlers,
  ipcHandleMock,
  wslInstallerMock,
  recordInstalledMock,
  recordRemovedMock,
  getDefaultWslDistroMock
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ipcHandleMock: vi.fn(),
  wslInstallerMock: vi.fn(),
  recordInstalledMock: vi.fn(),
  recordRemovedMock: vi.fn(),
  getDefaultWslDistroMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: ipcHandleMock } }))
vi.mock('../cli/cli-installer', () => ({ CliInstaller: vi.fn() }))
vi.mock('../cli/wsl-cli-installer', () => ({ WslCliInstaller: wslInstallerMock }))
vi.mock('../cli/wsl-cli-registration-registry', () => ({
  recordWslCliRegistrationInstalled: recordInstalledMock,
  recordWslCliRegistrationRemoved: recordRemovedMock
}))
vi.mock('../persistence', () => ({ getCanonicalUserDataPath: () => '/canonical-user-data' }))
vi.mock('../startup/hydrate-shell-path', () => ({
  hydrateShellPath: vi.fn(async () => ({ ok: false })),
  mergePathSegments: vi.fn()
}))
vi.mock('../wsl', () => ({ getDefaultWslDistro: getDefaultWslDistroMock }))

import { registerCliHandlers } from './cli'

type WslHandler = (event: unknown, args?: { distro?: string | null }) => Promise<{ state: string }>

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
    getDefaultWslDistroMock.mockReset().mockReturnValue('Ubuntu')
    registerCliHandlers()
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
})
