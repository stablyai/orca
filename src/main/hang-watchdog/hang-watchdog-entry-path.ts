import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function resolveHangWatchdogEntryPath(
  appPath: string,
  isPackaged: boolean,
  pathExists: (candidate: string) => boolean = existsSync
): string {
  // Why: ELECTRON_RUN_AS_NODE bypasses asar integration, so the packaged entry must be forked from app.asar.unpacked.
  const basePath = isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const adjacentBuildEntry = join(basePath, 'main-thread-hang-watchdog-entry.js')
  // Why: electron-vite's unpackaged appPath is already out/main; appending out/main again would silently disable the watchdog in dev and E2E builds.
  if (!isPackaged && pathExists(adjacentBuildEntry)) {
    return adjacentBuildEntry
  }
  return join(basePath, 'out', 'main', 'main-thread-hang-watchdog-entry.js')
}
