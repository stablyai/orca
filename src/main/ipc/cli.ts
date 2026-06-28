import { ipcMain } from 'electron'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { CliInstaller } from '../cli/cli-installer'
import { WslCliInstaller } from '../cli/wsl-cli-installer'
import { hydrateShellPath, mergePathSegments } from '../startup/hydrate-shell-path'

function normalizeWslCliDistro(args?: { distro?: string | null }): string | undefined {
  return args?.distro?.trim() || undefined
}

async function hydrateLocalShellPathForCli(force = false): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  // Why: CLI registration must match `which orca` in the user's terminal, not
  // the sparse PATH a GUI-launched Electron process inherited from launchd.
  const hydration = await hydrateShellPath(force ? { force: true } : undefined)
  if (hydration.ok) {
    mergePathSegments(hydration.segments)
  }
}

export function registerCliHandlers(): void {
  ipcMain.handle('cli:getInstallStatus', async (): Promise<CliInstallStatus> => {
    await hydrateLocalShellPathForCli()
    return new CliInstaller().getStatus()
  })

  ipcMain.handle('cli:install', async (): Promise<CliInstallStatus> => {
    await hydrateLocalShellPathForCli(true)
    return new CliInstaller().install()
  })

  ipcMain.handle('cli:remove', async (): Promise<CliInstallStatus> => {
    await hydrateLocalShellPathForCli()
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
