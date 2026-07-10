export const USAGE_WORKTREE_CANONICALIZATION_CONCURRENCY = 8

export type CanonicalizedUsageWorktree<T extends { path: string }> = T & {
  canonicalPath: string
}

export async function canonicalizeUsageWorktreePaths<T extends { path: string }>(
  worktrees: readonly T[],
  canonicalizePath: (path: string) => Promise<string>,
  concurrency = USAGE_WORKTREE_CANONICALIZATION_CONCURRENCY
): Promise<CanonicalizedUsageWorktree<T>[]> {
  if (worktrees.length === 0) {
    return []
  }

  // Why: usage scans can see many stale remembered worktrees. Bound realpath
  // fanout so opening the usage pane does not stampede the filesystem.
  const workerCount = Math.min(worktrees.length, Math.max(1, Math.floor(concurrency)))
  const canonicalized = Array.from<CanonicalizedUsageWorktree<T>>({ length: worktrees.length })
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < worktrees.length) {
      const index = nextIndex
      nextIndex++
      const worktree = worktrees[index]
      canonicalized[index] = {
        ...worktree,
        canonicalPath: await canonicalizePath(worktree.path)
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker))
  return canonicalized.sort((left, right) => right.canonicalPath.length - left.canonicalPath.length)
}
