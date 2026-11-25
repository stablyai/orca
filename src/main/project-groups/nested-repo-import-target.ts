import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { normalizeRuntimePathForComparison } from '../../shared/file-access/cross-platform-path'
import { listWorktreeGraph } from '../git/worktrees/catalog/worktree-scan-cache'

export type NestedRepoImportTargetResolver = {
  resolveLocal: (repoPath: string) => Promise<string>
  /** Non-bare checkouts sharing a resolved target's worktree graph; [] when Git could not prove one. */
  getFamilyPaths: (targetPath: string) => readonly string[]
}

type WorktreeGraphRead = {
  /** The non-bare main checkout imports stand for; null when the graph has none (a bare primary). */
  targetPath: string | null
  graphPaths: string[]
  /** Family identity is known whenever Git listed this graph, independent of where imports land. */
  familyPaths: string[]
}

function readImportGraph(
  selectedPath: string,
  worktrees: readonly GitWorktreeInfo[]
): WorktreeGraphRead | null {
  const selectedPathKey = normalizeRuntimePathForComparison(selectedPath)
  const graphContainsSelectedPath = worktrees.some(
    (worktree) => normalizeRuntimePathForComparison(worktree.path) === selectedPathKey
  )
  if (!graphContainsSelectedPath) {
    return null
  }
  // Collapse a linked worktree only with Git proof it shares this non-bare owner graph.
  const mainWorktree = worktrees.find((worktree) => worktree.isMainWorktree && !worktree.isBare)
  return {
    targetPath: mainWorktree?.path ?? null,
    graphPaths: worktrees.map((worktree) => worktree.path),
    familyPaths: worktrees.filter((worktree) => !worktree.isBare).map((worktree) => worktree.path)
  }
}

async function resolveWithCache(
  repoPath: string,
  cache: Map<string, string>,
  familyByPath: Map<string, string[]>,
  readWorktreeGraph: (path: string) => Promise<GitWorktreeInfo[]>
): Promise<string> {
  const repoPathKey = normalizeRuntimePathForComparison(repoPath)
  const cachedPath = cache.get(repoPathKey)
  if (cachedPath) {
    return cachedPath
  }

  try {
    const graph = readImportGraph(repoPath, await readWorktreeGraph(repoPath))
    if (graph) {
      for (const familyPath of graph.familyPaths) {
        familyByPath.set(normalizeRuntimePathForComparison(familyPath), graph.familyPaths)
      }
      if (graph.targetPath) {
        for (const graphPath of graph.graphPaths) {
          cache.set(normalizeRuntimePathForComparison(graphPath), graph.targetPath)
        }
        return graph.targetPath
      }
    }
  } catch {
    // Fall through to selected-path compatibility behavior.
  }
  cache.set(repoPathKey, repoPath)
  return repoPath
}

export function createNestedRepoImportTargetResolver(): NestedRepoImportTargetResolver {
  const localCache = new Map<string, string>()
  const familyByPath = new Map<string, string[]>()
  return {
    resolveLocal: (repoPath) =>
      resolveWithCache(repoPath, localCache, familyByPath, (path) => listWorktreeGraph(path)),
    getFamilyPaths: (targetPath) =>
      familyByPath.get(normalizeRuntimePathForComparison(targetPath)) ?? []
  }
}

export async function resolveLocalNestedRepoImportTargetPath(repoPath: string): Promise<string> {
  return createNestedRepoImportTargetResolver().resolveLocal(repoPath)
}
