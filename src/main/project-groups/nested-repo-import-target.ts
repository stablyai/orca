import { realpath } from 'node:fs/promises'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { normalizeRuntimePathForComparison } from '../../shared/file-access/cross-platform-path'
import { listWorktreeGraph } from '../git/worktrees/catalog/worktree-scan-cache'

export type NestedRepoImportTargetResolver = {
  resolveLocal: (repoPath: string) => Promise<string>
}

function findImportTarget(
  selectedPathKeys: ReadonlySet<string>,
  worktrees: readonly GitWorktreeInfo[]
): { targetPath: string; graphPaths: string[] } | null {
  const graphContainsSelectedPath = worktrees.some((worktree) =>
    selectedPathKeys.has(normalizeRuntimePathForComparison(worktree.path))
  )
  if (!graphContainsSelectedPath) {
    return null
  }

  const mainWorktree =
    worktrees.find((worktree) => worktree.isMainWorktree && !worktree.isBare) ??
    worktrees.find((worktree) => worktree.isMainWorktree && worktree.isBare)
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

  const resolvedRealPath = await realpath(repoPath).catch(() => null)
  const resolvedRealPathKey = resolvedRealPath
    ? normalizeRuntimePathForComparison(resolvedRealPath)
    : null
  if (resolvedRealPathKey) {
    const cachedRealPath = cache.get(resolvedRealPathKey)
    if (cachedRealPath) {
      cache.set(repoPathKey, cachedRealPath)
      return cachedRealPath
    }
  }

  const selectedPathKeys = new Set([repoPathKey])
  if (resolvedRealPathKey) {
    selectedPathKeys.add(resolvedRealPathKey)
  }

  try {
    const target = findImportTarget(selectedPathKeys, await readWorktreeGraph(repoPath))
    if (target) {
      for (const graphPath of target.graphPaths) {
        cache.set(normalizeRuntimePathForComparison(graphPath), target.targetPath)
      }
      cache.set(repoPathKey, target.targetPath)
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
