import { setIsolatedSpawner } from '@orca/process-host/isolated-detached-spawn'
import { loadWindowsSecurity } from '../../shared/windows-security-addon'

/** Long-lived detached children (the WSL holder) then inherit none of main's handles, e.g. a
 * DevTools socket. A missing or stale addon keeps libuv's spawn, which inherits them. */
export function installWindowsIsolatedSpawner(platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'win32') {
    return
  }
  try {
    const security = loadWindowsSecurity()
    if ('error' in security) {
      console.warn(
        `[startup] detached spawns inherit handles; addon unavailable: ${security.error}`
      )
      return
    }
    if (!security.addon.hasNativeExport('spawnDetachedIsolated')) {
      console.warn('[startup] detached spawns inherit handles; the addon build is stale')
      return
    }
    setIsolatedSpawner(security.addon.spawnDetachedIsolated)
  } catch (error) {
    console.warn('[startup] detached spawns inherit handles:', error)
  }
}
