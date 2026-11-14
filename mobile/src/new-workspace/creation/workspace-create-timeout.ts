// SSH clone/setup/startup can exceed the generic mobile timeout; match desktop’s ten-minute create budget.
export const WORKTREE_CREATE_TIMEOUT_MS = 10 * 60_000
