import { lstatSync, realpathSync } from 'node:fs'

export function resolveHooksJsonWritePath(configPath: string): string {
  let isSymlink = false
  try {
    isSymlink = lstatSync(configPath).isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    return configPath
  }
  if (isSymlink) {
    // Resolve symlinks before atomic replacement; dangling links must fail closed.
    return realpathSync.native(configPath)
  }
  return configPath
}
