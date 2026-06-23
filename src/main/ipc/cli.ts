import { ipcMain } from 'electron'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { CliInstaller } from '../cli/cli-installer'
import { WslCliInstaller } from '../cli/wsl-cli-installer'

function normalizeWslCliDistro(args?: { distro?: string | null }): string | undefined {
  return args?.distro?.trim() || undefined
}

export function registerCliHandlers(): void {
  ipcMain.handle('cli:getInstallStatus', async (): Promise<CliInstallStatus> => {
    return new CliInstaller().getStatus()
  })

  ipcMain.handle('cli:install', async (): Promise<CliInstallStatus> => {
    return new CliInstaller().install()
  })

  ipcMain.handle('cli:remove', async (): Promise<CliInstallStatus> => {
    return new CliInstaller().remove()
  })

  ipcMain.handle(
    'cli:getWslInstallStatus',
    async (_event, args?: { distro?: string | null }): Promise<CliInstallStatus> => {
      return new WslCliInstaller({ distro: normalizeWslCliDistro(args) }).getStatus()
    }
  )

  ipcMain.handle(
    'cli:installWsl',
    async (_event, args?: { distro?: string | null }): Promise<CliInstallStatus> => {
      return new WslCliInstaller({ distro: normalizeWslCliDistro(args) }).install()
    }
  )

  ipcMain.handle(
    'cli:removeWsl',
    async (_event, args?: { distro?: string | null }): Promise<CliInstallStatus> => {
      return new WslCliInstaller({ distro: normalizeWslCliDistro(args) }).remove()
    }
  )
}
