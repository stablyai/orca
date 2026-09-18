import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { resolveWorkspaceTrustMatch } from '../../shared/workspace-trust-resolution'
import type { WorkspaceTrustEntry } from '../../shared/workspace-trust-types'
import { canonicalizeAccessibleDirectory } from '../ipc/floating-workspace-directory'

/**
 * Two-phase trust check: phase 1 (textual, zero I/O) via `resolveWorkspaceTrustMatch`; phase 2
 * (canonical, only on a candidate grant) re-verifies both paths' realpaths still match, so a
 * symlink that textually sits inside a trusted root but resolves outside it reports untrusted.
 *
 * Why phase 2 is never memoized: a cached realpath keeps authorizing a symlink that has since
 * been retargeted outside the root — the exact case this phase exists to catch. The cost is one
 * syscall per path on a user-initiated action, so freshness beats any invalidation scheme.
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
    canonicalizeAccessibleDirectory(path),
    canonicalizeAccessibleDirectory(match.entry.path)
  ])
  if (!canonicalQuery || !canonicalEntry) {
    return false
  }
  return isPathInsideOrEqual(canonicalEntry, canonicalQuery)
}
