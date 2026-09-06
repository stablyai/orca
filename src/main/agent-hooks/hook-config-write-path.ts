import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'

export function isRepositoryManagedHookConfigSymlink(configPath: string): boolean {
  let isSymlink = false
  try {
    isSymlink = lstatSync(configPath).isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
  if (!isSymlink) {
    return false
  }

  let current = dirname(realpathSync.native(configPath))
  const root = parse(current).root
  while (true) {
    if (existsSync(join(current, '.git'))) {
      return true
    }
    if (current === root) {
      return false
    }
    current = dirname(current)
  }
}

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
