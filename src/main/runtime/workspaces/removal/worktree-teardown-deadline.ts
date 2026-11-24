/** Shared here to avoid a cycle between the teardown entrypoint and sweeps. */

// Settle stop RPCs before the sweep deadline so provider failures outrank the outer timeout; verification has its own budget (#11960).
export const WORKTREE_TEARDOWN_RPC_MARGIN_MS = 500

// Thread absolute deadlines through sequential RPCs; leaves compute remaining time when issuing.
export function teardownRpcDeadline(sweepDeadline: number): number {
  return sweepDeadline - WORKTREE_TEARDOWN_RPC_MARGIN_MS
}
