import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  observeResolvedFilePath,
  observeResolvedFilePathError
} from '../../../filesystem/file-content-observation'

/** Follow dotfile-manager symlinks, including dangling links realpath cannot resolve. */
export function resolvePromotionWriteTarget(systemTomlPath: string): { path: string } {
  try {
    const realPath = realpathSync(systemTomlPath)
    return { path: observeResolvedFilePath('promotion-write', systemTomlPath, realPath) }
  } catch (error) {
    observeResolvedFilePathError('promotion-write', systemTomlPath, error)
    // Continue below: realpath also fails for a valid dangling dotfile link.
  }
  let targetPath = systemTomlPath
  try {
    if (lstatSync(systemTomlPath).isSymbolicLink()) {
      targetPath = resolveDanglingSymlinkTarget(systemTomlPath)
    }
  } catch (error) {
    observeResolvedFilePathError('promotion-write', systemTomlPath, error)
    // Missing non-link targets are created owner-only where the requested path resolves.
  }
  return {
    path: observeResolvedFilePath(
      'promotion-write',
      systemTomlPath,
      resolveThroughLinkedAncestor(targetPath)
    )
  }
}

/** The nearest existing folder decides where a new file lands, e.g. a host ~/.codex linked into WSL. */
function resolveThroughLinkedAncestor(path: string): string {
  const missing = [basename(path)]
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    try {
      return join(realpathSync(dir), ...missing)
    } catch (error) {
      if (dirname(dir) === dir) {
        observeResolvedFilePathError('promotion-write', path, error)
        return path
      }
      missing.unshift(basename(dir))
    }
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
