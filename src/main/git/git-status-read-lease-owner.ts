// Why: the class moved to src/shared so the relay host can coalesce the same
// reads; this re-export keeps main's import path (and its tests) stable.
export { GitStatusReadLeaseOwner } from '../../shared/git-status-read-lease-owner'
