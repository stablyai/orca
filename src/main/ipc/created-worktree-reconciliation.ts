import { areWorktreePathsEqual } from './worktree-path-comparison'

const AMBIGUOUS_SSH_MUTATION_CODES = new Set(['CONNECTION_LOST', 'DISPOSED'])

export function isAmbiguousSshWorktreeAddError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const candidate = error as { code?: unknown; message?: unknown }
  return (
    (typeof candidate.code === 'string' && AMBIGUOUS_SSH_MUTATION_CODES.has(candidate.code)) ||
    (typeof candidate.message === 'string' &&
      /^Request "git\.addWorktree" timed out after \d+ms$/.test(candidate.message))
  )
}

export function findCreatedWorktree<T extends { path: string; branch?: string }>(
  worktrees: readonly T[],
  requestedPath: string,
  branchName: string,
  platform = process.platform
): T | undefined {
  const direct = worktrees.find((worktree) =>
    areWorktreePathsEqual(worktree.path, requestedPath, platform)
  )
  if (direct) {
    return direct
  }

  return worktrees.find((worktree) => worktree.branch === `refs/heads/${branchName}`)
}

export function findConfirmedCreatedWorktree<T extends { path: string; branch?: string }>(
  worktrees: readonly T[],
  requestedPath: string,
  branchName: string,
  platform = process.platform
): T | undefined {
  return worktrees.find(
    (worktree) =>
      areWorktreePathsEqual(worktree.path, requestedPath, platform) &&
      worktree.branch === `refs/heads/${branchName}`
  )
}
