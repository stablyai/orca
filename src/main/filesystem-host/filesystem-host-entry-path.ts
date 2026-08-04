import { existsSync } from 'node:fs'
import { join } from 'node:path'

export function resolveFilesystemHostEntryPath(
  appPath: string,
  isPackaged: boolean,
  pathExists: (candidate: string) => boolean = existsSync
): string {
  const basePath = isPackaged
    ? appPath.replace(/(^|[\\/])app\.asar$/, '$1app.asar.unpacked')
    : appPath
  const adjacentEntry = join(basePath, 'filesystem-host-entry.js')
  if (!isPackaged && pathExists(adjacentEntry)) {
    return adjacentEntry
  }
  return join(basePath, 'out', 'main', 'filesystem-host-entry.js')
}
