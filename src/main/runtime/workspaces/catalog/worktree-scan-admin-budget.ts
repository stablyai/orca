import { RESOLVED_WORKTREE_REPO_TIMEOUT_MS } from './repo-worktree-row-resolution'

// Sparse patterns and packed-ref/reftable tip edits can evade admin stamps; periodically force a real scan.
export const WORKTREE_SCAN_ADMIN_RECONCILE_INTERVAL_MS = 5 * 60_000

// Reserve fallback git worktree list time inside the caller's budget, even after probe timeout.
const WORKTREE_SCAN_FALLBACK_ALLOWANCE_MS = 1500

// Bound probes inside repo timeout minus fallback allowance; expired probes return null and force a real scan.
// Smaller probe budgets would discard usable results: fallback reads a superset of the same files.
export const WORKTREE_SCAN_ADMIN_FINGERPRINT_TIMEOUT_MS =
  RESOLVED_WORKTREE_REPO_TIMEOUT_MS - WORKTREE_SCAN_FALLBACK_ALLOWANCE_MS
