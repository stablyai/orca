import { describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../../../shared/cli/cli-install-types'
import { eraseRpcMethods, type RpcContext } from '../core'
import { CLI_METHODS } from './cli'

const mocks = vi.hoisted(() => ({
  getCliInstallStatus: vi.fn(),
  installCli: vi.fn(),
  removeCli: vi.fn(),
  getWslCliInstallStatus: vi.fn(),
  installWslCli: vi.fn(),
  removeWslCli: vi.fn()
}))

vi.mock('../../../cli/cli-registration-service', () => mocks)

const status: CliInstallStatus = {
  platform: 'win32',
  commandName: 'orca',
  commandPath: 'C:\\Users\\me\\AppData\\Local\\Orca\\orca.exe',
  pathDirectory: 'C:\\Users\\me\\AppData\\Local\\Orca',
  pathConfigured: true,
  launcherPath: 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe',
  installMethod: 'wrapper',
  supported: true,
  state: 'installed',
  currentTarget: 'C:\\Program Files\\Orca\\resources\\bin\\orca.exe',
  unsupportedReason: null,
  detail: 'Registered.'
}

describe('CLI runtime RPC methods', () => {
  it('exposes the same local and WSL operations as Electron IPC', async () => {
    mocks.getCliInstallStatus.mockResolvedValue(status)
    mocks.installCli.mockResolvedValue(status)
    mocks.removeCli.mockResolvedValue(status)
    mocks.getWslCliInstallStatus.mockResolvedValue(status)
    mocks.installWslCli.mockResolvedValue(status)
    mocks.removeWslCli.mockResolvedValue(status)

    const methods = eraseRpcMethods(CLI_METHODS)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: CLI handlers ignore context and delegate only to the mocked registration service.
    const context = {} as RpcContext
    expect(methods.map((method) => method.name)).toEqual([
      'cli.getInstallStatus',
      'cli.install',
      'cli.remove',
      'cli.getWslInstallStatus',
      'cli.installWsl',
      'cli.removeWsl'
    ])
    expect(methods.map((method) => method.permission)).toEqual([
      'workspace',
      'host-admin',
      'host-admin',
      'workspace',
      'host-admin',
      'host-admin'
    ])

    await expect(methods[0].handler(undefined, context)).resolves.toBe(status)
    await expect(methods[1].handler(undefined, context)).resolves.toBe(status)
    await expect(methods[2].handler(undefined, context)).resolves.toBe(status)
    await expect(
      methods[3].handler(methods[3].params?.parse({ distro: ' Debian ' }), context)
    ).resolves.toBe(status)
    await expect(
      methods[4].handler(methods[4].params?.parse({ distro: ' Debian ' }), context)
    ).resolves.toBe(status)
    await expect(
      methods[5].handler(methods[5].params?.parse({ distro: null }), context)
    ).resolves.toBe(status)

    expect(mocks.getCliInstallStatus).toHaveBeenCalledOnce()
    expect(mocks.installCli).toHaveBeenCalledOnce()
    expect(mocks.removeCli).toHaveBeenCalledOnce()
    expect(mocks.getWslCliInstallStatus).toHaveBeenCalledWith({ distro: ' Debian ' })
    expect(mocks.installWslCli).toHaveBeenCalledWith({ distro: ' Debian ' })
    expect(mocks.removeWslCli).toHaveBeenCalledWith({ distro: null })
  })

  it('accepts an omitted WSL distro as a local default selector', () => {
    const method = eraseRpcMethods(CLI_METHODS).find(
      (candidate) => candidate.name === 'cli.getWslInstallStatus'
    )
    expect(method?.params?.parse({})).toEqual({})
  })
})
