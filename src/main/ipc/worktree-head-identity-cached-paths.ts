import type { WorktreeHeadIdentityCache } from './worktree-head-identity-reader'
import {
  headIdentityEntryKey,
  type WorktreeHeadIdentityScope
} from './worktree-head-identity-scope'

/** Return null if any scoped checkout is unattributable; callers must then refresh globally. */
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
  // Case-folded keys can match distinct Foo/foo entries; preserve every checkout path.
  const pathsByEntryKey = new Map<string, string[]>()
  for (const [name, identity] of cache.entries) {
    const key = headIdentityEntryKey(name)
    pathsByEntryKey.set(key, [...(pathsByEntryKey.get(key) ?? []), identity.worktreePath])
  }
  for (const key of scope.entryNames) {
    const entryPaths = pathsByEntryKey.get(key)
    if (entryPaths === undefined) {
      return null
    }
    paths.push(...entryPaths)
  }
  return paths
}
