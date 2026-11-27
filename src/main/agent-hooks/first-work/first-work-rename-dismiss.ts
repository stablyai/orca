import type { BranchAutoRenameDismissResult } from '../../../shared/worktree/branch-auto-rename-attempt'
import { settleFirstWorkRename, type FirstWorkAttemptDeps } from './first-work-rename-attempts'

export type FirstWorkDismissDeps = FirstWorkAttemptDeps & {
  /** Persists "keep this name": clears the error and makes the workspace ineligible for auto-naming.
   *  False when this host has no row to write. */
  keepCurrentName: (worktreeId: string) => boolean
}

/** Dismiss: keep the current name and stop retrying, across restarts. */
export function dismissFirstWorkRename(
  worktreeId: string,
  deps: FirstWorkDismissDeps
): BranchAutoRenameDismissResult {
  const incarnation = deps.readIncarnation(worktreeId)
  if (!incarnation) {
    return { dismissed: false }
  }
  if (!deps.keepCurrentName(worktreeId)) {
    return { dismissed: false }
  }
  settleFirstWorkRename(worktreeId, incarnation)
  return { dismissed: true }
}
