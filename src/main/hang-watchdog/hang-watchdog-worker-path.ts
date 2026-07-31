import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function resolveHangWatchdogWorkerPath(
  appPath: string,
  isPackaged: boolean,
  pathExists: (candidate: string) => boolean = existsSync
): string {
  const adjacentBuildEntry = join(appPath, 'main-thread-hang-watchdog-entry.js')
  if (!isPackaged && pathExists(adjacentBuildEntry)) {
    return adjacentBuildEntry
  }
  return join(appPath, 'out', 'main', 'main-thread-hang-watchdog-entry.js')
}
