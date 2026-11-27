import { lstatSync, realpathSync } from 'node:fs'
import {
  observeFileReadError,
  observeResolvedFilePath
} from '../../../filesystem/file-content-observation'

export function resolveHooksJsonWritePath(configPath: string): string {
  let isSymlink = false
  try {
    isSymlink = lstatSync(configPath).isSymbolicLink()
  } catch (error) {
    observeFileReadError(configPath, error)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    return observeResolvedFilePath('hooks-write', configPath, configPath)
  }
  if (isSymlink) {
    // Resolve symlinks before atomic replacement; dangling links must fail closed.
    return observeResolvedFilePath('hooks-write', configPath, realpathSync.native(configPath))
  }
  return observeResolvedFilePath('hooks-write', configPath, configPath)
}
