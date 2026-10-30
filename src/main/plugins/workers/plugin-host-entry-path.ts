import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Fork the unpacked entry because Node cannot execute inside app.asar. */
export function resolvePluginHostEntryPath(appPath: string, isPackaged: boolean): string {
  const basePath = isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const directEntryPath = join(basePath, 'plugin-host-entry.js')
  if (existsSync(directEntryPath)) {
    return directEntryPath
  }
  return join(basePath, 'out', 'main', 'plugin-host-entry.js')
}
