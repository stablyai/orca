import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The plugin folder `cwd` is in: the nearest directory holding `orca-plugin.json`, looking up no
 * further than the repository root (the first directory with `.git`).
 */
export function enclosingPluginFolder(
  cwd: string,
  exists: (path: string) => boolean = existsSync
): string | null {
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (exists(join(dir, 'orca-plugin.json'))) {
      return dir
    }
    if (exists(join(dir, '.git')) || dirname(dir) === dir) {
      return null
    }
  }
}

/** Where shots go without --out: beside the plugin, as `dev watch --shot` writes them. */
export function defaultPluginShotsDir(
  cwd: string,
  exists: (path: string) => boolean = existsSync
): string {
  return join(enclosingPluginFolder(cwd, exists) ?? cwd, '.orca', 'shots')
}
