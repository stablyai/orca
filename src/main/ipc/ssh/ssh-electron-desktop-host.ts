import { powerMonitor, type BrowserWindow } from 'electron'
import type { SshDesktopHost } from '../../ssh/application/ssh-desktop-host'
import { notifyReposChanged } from '../repos/repos-changed-notification'

export function createElectronSshDesktopHost(
  getMainWindow: () => BrowserWindow | null
): SshDesktopHost {
  return {
    publish(channel, payload) {
      const win = getMainWindow()
      if (!win || win.isDestroyed()) {
        return false
      }
      win.webContents.send(channel, payload)
      return true
    },
    reposChanged: () => notifyReposChanged(getMainWindow()),
    onHostResume(listener) {
      powerMonitor.on('resume', listener)
      // macOS/Windows lock without sleep can still drop VPN routes.
      powerMonitor.on('unlock-screen', listener)
      return () => {
        powerMonitor.off('resume', listener)
        powerMonitor.off('unlock-screen', listener)
      }
    },
    async clearTargetBrowserStorage(targetId) {
      const [partitions, storage] = await Promise.all([
        import('../../browser/routing/local-host-partitions/local-ssh-browser-partitions'),
        import('../../browser/routing/partitions/browser-route-partition-storage-runtime')
      ])
      await partitions.releaseLocalSshBrowserPartitionsForTarget(targetId)
      await storage.clearBrowserRoutePartitionStorageForLocalSshTarget(targetId)
      // A prepare can re-register during removal; sweep again after the release/clear race.
      await new Promise((resolve) => setTimeout(resolve, 500))
      await partitions.releaseLocalSshBrowserPartitionsForTarget(targetId)
      await storage.clearBrowserRoutePartitionStorageForLocalSshTarget(targetId)
    }
  }
}
