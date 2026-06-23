export type WorktreeDisplayNameSource = {
  worktreeId?: string
  id?: string
  displayName?: string | null
  repo?: string | null
}

export function getLiveWorktreeDisplayName(
  worktrees: readonly WorktreeDisplayNameSource[],
  worktreeId: string
): string | null {
  const worktree = worktrees.find((item) => (item.worktreeId ?? item.id) === worktreeId)
  if (!worktree) {
    return null
  }
  const displayName = worktree.displayName?.trim()
  if (displayName) {
    return displayName
  }
  return worktree.repo?.trim() || null
}
