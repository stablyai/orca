import { lstatSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Where a promotion write actually lands. `~/.codex/config.toml` is commonly a
 * dotfile-manager symlink, so the write has to follow it — including when the
 * link is dangling, which `realpathSync` cannot resolve.
 */
export function resolvePromotionWriteTarget(systemTomlPath: string): {
  path: string
  mode: number
} {
  try {
    const realPath = realpathSync(systemTomlPath)
    return { path: realPath, mode: statSync(realPath).mode & 0o777 }
  } catch {
    // Continue below: realpath also fails for a valid dangling dotfile link.
  }
  try {
    if (lstatSync(systemTomlPath).isSymbolicLink()) {
      const targetPath = resolveDanglingSymlinkTarget(systemTomlPath)
      return { path: targetPath, mode: 0o600 }
    }
  } catch {
    // Missing non-link targets are created owner-only at the requested path.
  }
  return { path: systemTomlPath, mode: 0o600 }
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
    } catch {
      return currentPath
    }
  }
  // Why: replacing any link in a cycle would destroy dotfile-manager state; abort instead.
  throw new Error(`Codex config symlink cycle at ${linkPath}`)
}
