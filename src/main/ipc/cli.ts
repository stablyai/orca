import { ipcMain } from 'electron'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { CliInstaller } from '../cli/cli-installer'
import { WslCliInstaller } from '../cli/wsl-cli-installer'

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

  ipcMain.handle('cli:getWslInstallStatus', async (): Promise<CliInstallStatus> => {
    return new WslCliInstaller().getStatus()
  })

  ipcMain.handle('cli:installWsl', async (): Promise<CliInstallStatus> => {
    return new WslCliInstaller().install()
  })

  ipcMain.handle('cli:removeWsl', async (): Promise<CliInstallStatus> => {
    return new WslCliInstaller().remove()
  })
}
