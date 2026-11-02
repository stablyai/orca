import { ipcMain } from 'electron'
import {
  validatePathExistenceBatch,
  type ShellPathExistence
} from '../../shared/path-existence-batch'
import { pathExists } from './shell-owned-path-target'
import { guardWslUncPathAccess, WslDistroStoppedError } from '../wsl/wsl-unc-access-gate'

/** Existence checks of host paths; a stopped WSL distro's UNC path is refused unless a user act asks (E9). */
export function registerShellPathExistenceHandlers(): void {
  ipcMain.handle(
    'shell:pathsExist',
    async (_event, paths: string[]): Promise<ShellPathExistence[]> => {
      validatePathExistenceBatch(paths)
      // Chat link renders and terminal hovers ask unprompted: a stat of a stopped distro's UNC path
      // boots it (E9). Refuse that path alone, so the caller retries it and keeps the rest.
      return Promise.all(
        paths.map((path) =>
          guardWslUncPathAccess(path, () => pathExists(path)).catch(
            (error: unknown): ShellPathExistence => ({
              error: error instanceof Error ? error.message : String(error)
            })
          )
        )
      )
    }
  )

  ipcMain.handle(
    'shell:pathExists',
    async (_event, filePath: string, options?: { wakeWslDistro?: boolean }): Promise<boolean> =>
      // Settings mounts ask unprompted, and a UNC stat boots a stopped distro (E9); clicks wake it.
      guardWslUncPathAccess(filePath, () => pathExists(filePath), {
        wake: options?.wakeWslDistro === true
      }).catch((error: unknown) => {
        // A mount's own Retry asks again in the background, so it can't start the distro either.
        throw error instanceof WslDistroStoppedError
          ? new WslDistroStoppedError(error.distro, { retryStartsIt: false })
          : error
      })
  )
}
