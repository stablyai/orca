import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { listWorktreeGraph } from '../git/worktree'

export type NestedRepoImportTargetResolver = {
  resolveLocal: (repoPath: string) => Promise<string>
}

function findImportTarget(
  selectedPath: string,
  worktrees: readonly GitWorktreeInfo[]
): { targetPath: string; graphPaths: string[] } | null {
  const selectedPathKey = normalizeRuntimePathForComparison(selectedPath)
  const graphContainsSelectedPath = worktrees.some(
    (worktree) => normalizeRuntimePathForComparison(worktree.path) === selectedPathKey
  )
  if (!graphContainsSelectedPath) {
    return null
  }

  // Collapse a linked worktree only with Git proof it shares this non-bare owner graph.
  const mainWorktree = worktrees.find((worktree) => worktree.isMainWorktree && !worktree.isBare)
  return mainWorktree
    ? { targetPath: mainWorktree.path, graphPaths: worktrees.map((worktree) => worktree.path) }
    : null
}

async function resolveWithCache(
  repoPath: string,
  cache: Map<string, string>,
  readWorktreeGraph: (path: string) => Promise<GitWorktreeInfo[]>
): Promise<string> {
  const repoPathKey = normalizeRuntimePathForComparison(repoPath)
  const cachedPath = cache.get(repoPathKey)
  if (cachedPath) {
    return cachedPath
  }

  try {
    const target = findImportTarget(repoPath, await readWorktreeGraph(repoPath))
    if (target) {
      for (const graphPath of target.graphPaths) {
        cache.set(normalizeRuntimePathForComparison(graphPath), target.targetPath)
      }
      return target.targetPath
    }
  } catch {
    // Fall through to selected-path compatibility behavior.
  }
  cache.set(repoPathKey, repoPath)
  return repoPath
}

export function createNestedRepoImportTargetResolver(): NestedRepoImportTargetResolver {
  const localCache = new Map<string, string>()
  return {
    resolveLocal: (repoPath) =>
      resolveWithCache(repoPath, localCache, (path) => listWorktreeGraph(path))
  }
}

export async function resolveLocalNestedRepoImportTargetPath(repoPath: string): Promise<string> {
  return createNestedRepoImportTargetResolver().resolveLocal(repoPath)
}
