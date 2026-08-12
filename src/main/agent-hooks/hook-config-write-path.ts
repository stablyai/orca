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
    // Why: atomic rename on the link path disconnects dotfiles-managed hook
    // configs. A dangling link must fail closed rather than be replaced.
    return realpathSync.native(configPath)
  }
  return configPath
}
