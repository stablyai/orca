import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { resolveWorkspaceTrustMatch } from '../../shared/workspace-trust-resolution'
import type { WorkspaceTrustEntry } from '../../shared/workspace-trust-types'
import { canonicalizeAccessibleDirectory } from '../ipc/floating-workspace-directory'

// Why: positive results only. An unmounted/deleted path must recover on remount with no
// restart (decision 10), so a failure is never cached — only a successful realpath is.
const canonicalPathCache = new Map<string, string>()

export function invalidateWorkspaceTrustPathCache(): void {
  canonicalPathCache.clear()
}

async function canonicalizeCached(dirPath: string): Promise<string | null> {
  const cached = canonicalPathCache.get(dirPath)
  if (cached !== undefined) {
    return cached
  }
  const canonical = await canonicalizeAccessibleDirectory(dirPath)
  if (canonical) {
    canonicalPathCache.set(dirPath, canonical)
  }
  return canonical
}

/**
 * Two-phase trust check: phase 1 (textual, zero I/O) via `resolveWorkspaceTrustMatch`; phase 2
 * (canonical, only on a candidate grant) re-verifies both paths' realpaths still match, so a
 * symlink that textually sits inside a trusted root but resolves outside it reports untrusted.
 */
export async function resolveWorkspaceTrustForPath(
  path: string,
  entries: readonly WorkspaceTrustEntry[]
): Promise<boolean> {
  const match = resolveWorkspaceTrustMatch(path, entries)
  if (!match || !match.entry.trusted) {
    return false
  }
  const [canonicalQuery, canonicalEntry] = await Promise.all([
    canonicalizeCached(path),
    canonicalizeCached(match.entry.path)
  ])
  if (!canonicalQuery || !canonicalEntry) {
    return false
  }
  return isPathInsideOrEqual(canonicalEntry, canonicalQuery)
}
