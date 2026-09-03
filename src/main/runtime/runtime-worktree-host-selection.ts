type HostOwnedWorktree = {
  hostId?: string
}

export function selectHostFairWorktrees<T extends HostOwnedWorktree>(
  worktrees: readonly T[],
  limit: number
): T[] {
  const firstIndexByHost = worktrees.reduce(
    (first, worktree, index) =>
      first.has(worktree.hostId ?? 'legacy')
        ? first
        : first.set(worktree.hostId ?? 'legacy', index),
    new Map<string, number>()
  )
  const selectedIndexes = new Set(
    [...new Set([...firstIndexByHost.values(), ...worktrees.map((_, index) => index)])].slice(
      0,
      limit
    )
  )
  return worktrees.filter((_worktree, index) => selectedIndexes.has(index))
}
