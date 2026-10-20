import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Resolves the compiled child entry from the app path. Mirrors
 * getDaemonEntryPath(): packaged apps must fork the asar-unpacked copy
 * because fork() cannot execute scripts from inside app.asar.
 */
export function resolvePluginHostEntryPath(appPath: string, isPackaged: boolean): string {
  const basePath = isPackaged ? appPath.replace('app.asar', 'app.asar.unpacked') : appPath
  const directEntryPath = join(basePath, 'plugin-host-entry.js')
  if (existsSync(directEntryPath)) {
    return directEntryPath
  }
  return join(basePath, 'out', 'main', 'plugin-host-entry.js')
}
