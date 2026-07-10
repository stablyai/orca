const worktreeChangeInvalidators = new Set<(repoId: string) => void>()

export function registerWorktreeChangeInvalidator(
  invalidator: (repoId: string) => void
): () => void {
  worktreeChangeInvalidators.add(invalidator)
  return () => {
    worktreeChangeInvalidators.delete(invalidator)
  }
}

export function runWorktreeChangeInvalidators(repoId: string): void {
  const invalidators = Array.from(worktreeChangeInvalidators)
  for (const invalidator of invalidators) {
    try {
      invalidator(repoId)
    } catch (error) {
      console.warn('[worktrees] worktree change invalidator failed:', error)
    }
  }
}

export function __resetWorktreeChangeInvalidatorsForTests(): void {
  worktreeChangeInvalidators.clear()
}
