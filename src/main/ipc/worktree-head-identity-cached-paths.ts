import type { WorktreeHeadIdentityCache } from './worktree-head-identity-reader'
import {
  headIdentityEntryKey,
  type WorktreeHeadIdentityScope
} from './worktree-head-identity-scope'

/** Checkout paths the memo maps `scope` to, or null when any part of it cannot
 *  be attributed (global scope, or an entry/primary the memo has not resolved). */
export function cachedWorktreePathsForScope(
  cache: WorktreeHeadIdentityCache,
  scope: WorktreeHeadIdentityScope
): string[] | null {
  if (scope.all || scope.listing || (!scope.primary && scope.entryNames.size === 0)) {
    return null
  }
  const paths: string[] = []
  if (scope.primary) {
    if (!cache.primary) {
      return null
    }
    paths.push(cache.primary.worktreePath)
  }
  const pathsByEntryKey = new Map<string, string>()
  for (const [name, identity] of cache.entries) {
    pathsByEntryKey.set(headIdentityEntryKey(name), identity.worktreePath)
  }
  for (const key of scope.entryNames) {
    const path = pathsByEntryKey.get(key)
    if (path === undefined) {
      return null
    }
    paths.push(path)
  }
  return paths
}
