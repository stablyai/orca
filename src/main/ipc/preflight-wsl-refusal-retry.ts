import { BrowserWindow } from 'electron'
import { deferUntilWslDistroRunning } from '../wsl-background-distro-gate'
import { WslDistroStoppedError, WslDistroUnverifiableError } from '../wsl/wsl-unc-access-gate'

export const PREFLIGHT_WSL_DISTRO_RUNNING_CHANNEL = 'preflight:wslDistroRunning'
const RETRY_KEY = 'preflight-refused'

function broadcastWslDistroRunning(distro: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) {
      continue
    }
    try {
      window.webContents.send(PREFLIGHT_WSL_DISTRO_RUNNING_CHANNEL, distro)
    } catch {
      // A renderer can disappear between isDestroyed() and send().
    }
  }
}

/** A refused background check is deferred, not done: renderers re-ask once the distro runs (E9). */
export async function deferRefusedPreflight<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof WslDistroStoppedError || error instanceof WslDistroUnverifiableError) {
      const { distro } = error
      deferUntilWslDistroRunning(distro, RETRY_KEY, () => broadcastWslDistroRunning(distro))
    }
    throw error
  }
}
