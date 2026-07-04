import { realpathSync } from 'node:fs'
import { isWslUncPath } from '../../shared/wsl-paths'

// Why: terminal startup cwd containment is string-based; realpath closes the
// symlink escape for local paths. Only for local worktrees — SSH/remote paths
// are not resolvable on this filesystem.
export function canonicalizeLocalTerminalPath(targetPath: string): string | null {
  // Why: realpath over the WSL 9P share is unreliable and can block the main
  // process while the distro boots; keep the string containment check only.
  if (isWslUncPath(targetPath)) {
    return null
  }
  try {
    return realpathSync.native(targetPath)
  } catch {
    try {
      // Why: realpathSync.native can fail on network/UNC mounts where the
      // JS implementation still succeeds (same fallback as git repo scanning).
      return realpathSync(targetPath)
    } catch {
      return null
    }
  }
}

export function localTerminalCwdCanonicalizer(
  connectionId: string | null | undefined
): ((path: string) => string | null) | undefined {
  return connectionId ? undefined : canonicalizeLocalTerminalPath
}
