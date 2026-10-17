import { isDescendantOrEqual } from './filesystem-path-containment'
import { hasGitMarker } from '../project-groups/nested-repo-discovery'

export function findLongestRegisteredAncestor(
  targetPath: string,
  roots: Iterable<string>
): string | null {
  let bestRoot: string | null = null
  for (const root of roots) {
    if (isDescendantOrEqual(targetPath, root) && (!bestRoot || root.length > bestRoot.length)) {
      bestRoot = root
    }
  }
  return bestRoot
}

/** Independent git roots under a registered worktree stay authorized for SCM. */
export async function resolveNestedGitRootUnderAncestor(
  normalizedTarget: string,
  ancestorRoot: string | null
): Promise<string | null> {
  if (!ancestorRoot || ancestorRoot === normalizedTarget) {
    return null
  }
  return (await hasGitMarker(normalizedTarget)) ? normalizedTarget : null
}

/** The ancestor itself, or a descendant that is its own git root — not a plain subdirectory. */
export async function isNestedGitRootInside(
  targetPath: string,
  ancestorPath: string,
  isInside: (target: string, ancestor: string) => boolean
): Promise<boolean> {
  if (targetPath === ancestorPath) {
    return true
  }
  if (!isInside(targetPath, ancestorPath)) {
    return false
  }
  return hasGitMarker(targetPath)
}

export async function worktreePathBelongsToRepo(
  targetPath: string,
  repoPath: string,
  worktreePaths: readonly string[],
  isInside: (target: string, ancestor: string) => boolean
): Promise<boolean> {
  if (await isNestedGitRootInside(targetPath, repoPath, isInside)) {
    return true
  }
  for (const worktreePath of worktreePaths) {
    if (await isNestedGitRootInside(targetPath, worktreePath, isInside)) {
      return true
    }
  }
  return false
}
