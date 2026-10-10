// Why: desktop remote worktree creation uses the same 10-minute RPC budget.
// SSH clone/setup/startup can legitimately exceed the generic 30s mobile RPC timeout.
export const WORKTREE_CREATE_TIMEOUT_MS = 10 * 60_000

// Why: repo.clone runs a full git clone of a remote URL on the host, which can
// exceed the generic 30s mobile RPC timeout for the same reason creation can.
export const REPO_CLONE_TIMEOUT_MS = 10 * 60_000
