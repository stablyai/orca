/** Refusal for an automatic spawn into a worktree whose terminals the host has put to sleep. */
export const WORKTREE_TERMINALS_SLEEPING_ERROR = 'worktree_terminals_sleeping'

export function isWorktreeTerminalsSleepingError(error: unknown): boolean {
  return error instanceof Error && error.message === WORKTREE_TERMINALS_SLEEPING_ERROR
}
