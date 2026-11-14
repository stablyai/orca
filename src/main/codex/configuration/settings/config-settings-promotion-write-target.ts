import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import {
  observeResolvedFilePath,
  observeResolvedFilePathError
} from '../../../filesystem/file-content-observation'

/** Follow dotfile-manager symlinks, including dangling links realpath cannot resolve. */
export function resolvePromotionWriteTarget(systemTomlPath: string): {
  path: string
  mode: number
} {
  try {
    const realPath = realpathSync(systemTomlPath)
    return {
      path: observeResolvedFilePath('promotion-write', systemTomlPath, realPath),
      mode: statSync(realPath).mode & 0o777
    }
  } catch (error) {
    observeResolvedFilePathError('promotion-write', systemTomlPath, error)
    // Continue below: realpath also fails for a valid dangling dotfile link.
  }
  try {
    if (lstatSync(systemTomlPath).isSymbolicLink()) {
      const targetPath = resolveDanglingSymlinkTarget(systemTomlPath)
      return {
        path: observeResolvedFilePath('promotion-write', systemTomlPath, targetPath),
        mode: 0o600
      }
    }
  } catch (error) {
    observeResolvedFilePathError('promotion-write', systemTomlPath, error)
    // Missing non-link targets are created owner-only at the requested path.
  }
  return {
    path: observeResolvedFilePath('promotion-write', systemTomlPath, systemTomlPath),
    mode: 0o600
  }
}

function resolveDanglingSymlinkTarget(linkPath: string): string {
  let currentPath = linkPath
  const visited = new Set<string>()
  while (!visited.has(currentPath)) {
    visited.add(currentPath)
    try {
      if (!lstatSync(currentPath).isSymbolicLink()) {
        return currentPath
      }
      currentPath = resolve(dirname(currentPath), readlinkSync(currentPath))
    } catch (error) {
      observeResolvedFilePathError('promotion-write', linkPath, error)
      return currentPath
    }
  }
  // Abort rather than overwrite a link in the dotfile-manager cycle.
  throw new Error(`Codex config symlink cycle at ${linkPath}`)
}
