import {
  STARTUP_WORKTREE_HYDRATION_LIMIT,
  startupWorktreeHydrationOverrunMessage
} from '../../shared/startup-worktree-hydration-budget'

export type StartupWorktreeHydrationCensus = {
  worktreeCount: number
  limit: number
  message: string
}

let census: StartupWorktreeHydrationCensus | null = null

/** Remember the largest over-limit catalog seen this process. Under-limit lists do not clear it. */
export function noteStartupWorktreeListCount(worktreeCount: number): void {
  if (!Number.isFinite(worktreeCount) || worktreeCount <= STARTUP_WORKTREE_HYDRATION_LIMIT) {
    return
  }
  if (census && census.worktreeCount >= worktreeCount) {
    return
  }
  const limit = STARTUP_WORKTREE_HYDRATION_LIMIT
  census = {
    worktreeCount,
    limit,
    message: startupWorktreeHydrationOverrunMessage(worktreeCount, limit)
  }
}

export function readStartupWorktreeHydrationCensus(): StartupWorktreeHydrationCensus | null {
  return census
}

export function resetStartupWorktreeHydrationCensusForTests(): void {
  census = null
}
