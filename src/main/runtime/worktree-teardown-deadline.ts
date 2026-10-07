/**
 * The one deadline arithmetic worktree teardown shares.
 *
 * Its own module because both the teardown entry point and the PTY-surface sweeps need it, and a
 * sweep importing the entry point back would be a cycle.
 */

// Why: keep each bounded stop RPC settling before the sweep deadline itself, so
// a wedged provider surfaces as a stop failure rather than as the outer timeout.
// (The recheck this margin once also reserved time for now runs on its own
// budget — see verifyUnstoppedPtys — because sharing this one wedged #11960.)
export const WORKTREE_TEARDOWN_RPC_MARGIN_MS = 500

// Absolute deadline (epoch ms) threaded into provider RPCs on the destructive
// path; each RPC leaf converts it to the remaining time when it actually issues,
// so sequential RPCs share one budget without any relative-timeout bookkeeping.
export function teardownRpcDeadline(sweepDeadline: number): number {
  return sweepDeadline - WORKTREE_TEARDOWN_RPC_MARGIN_MS
}
