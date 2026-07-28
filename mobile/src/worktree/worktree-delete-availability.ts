import type { Worktree } from './workspace-list-types'

// Why: mobile has no project-removal flow, so point at the one place that does.
export const MAIN_WORKTREE_DELETE_HINT = 'Remove the project from Orca on desktop instead'

/**
 * Git refuses to remove a repo's primary checkout, and the runtime refuses to remove a
 * folder project's root workspace — both arrive here as `isMainWorktree`. Desktop never
 * offers the action for them; mobile must not either, or the row is a dead button.
 */
export function canDeleteWorktreeFromMobile(worktree: Pick<Worktree, 'isMainWorktree'>): boolean {
  // Hosts predating isMainWorktree in worktree.ps report nothing here; let the runtime
  // answer rather than guessing from the branch name and blocking a deletable worktree.
  return worktree.isMainWorktree !== true
}
