// Why: desktop remote worktree creation uses the same 10-minute RPC budget.
// SSH clone/setup/startup can legitimately exceed the generic 30s mobile RPC timeout.
export const WORKTREE_CREATE_TIMEOUT_MS = 10 * 60_000
