import type { ExecutionHostId } from '../../shared/execution-host'
import { selectHostBalancedPage } from '../../shared/host-balanced-listing-page'
import type { RuntimeListingHostScope } from '../../shared/runtime-listing-host-scope'

/**
 * Applies a worktree listing's row cap and reports which hosts the resulting page covers.
 *
 * Rows are resolved repo by repo, so every SSH repo's rows land contiguously at the end of the
 * fleet order: 24 remote worktrees sat at indices 496-520 of 521 and a 200-row cap returned zero
 * of them (#18104). Balancing the page across hosts fixes the starvation; the scope is what makes
 * the remaining gap legible, because a host with no rows in the page is otherwise indistinguishable
 * from a host with no worktrees — which `docs/reference/ssh-execution-boundary.md` forbids a
 * listing from implying.
 */
export function buildWorktreeListingPage<TRow extends { hostId?: ExecutionHostId }>(
  rows: readonly TRow[],
  limit: number,
  knownHostIds: Iterable<ExecutionHostId>
): {
  worktrees: TRow[]
  hostScope: RuntimeListingHostScope
  totalCount: number
  truncated: boolean
} {
  const page = selectHostBalancedPage(rows, limit, (row) => row.hostId)
  return {
    worktrees: page,
    hostScope: buildWorktreeListingHostScope({
      pageHostIds: page.map((row) => row.hostId),
      matchedHostIds: rows.map((row) => row.hostId),
      knownHostIds
    }),
    totalCount: rows.length,
    truncated: rows.length > limit
  }
}

/**
 * The worktree-listing counterpart of `buildTerminalListHostScope`: names the hosts the returned
 * page covers, and every host it does not — including a configured repo whose scan failed, which
 * contributes zero rows exactly like a host with no worktrees.
 */
export function buildWorktreeListingHostScope(args: {
  /** Hosts of the rows actually returned. */
  pageHostIds: Iterable<ExecutionHostId | undefined>
  /** Hosts of every row that matched, including those the cap dropped. */
  matchedHostIds: Iterable<ExecutionHostId | undefined>
  /** Hosts this runtime has configured repos or workspaces on, even if they contributed no rows. */
  knownHostIds: Iterable<ExecutionHostId>
}): RuntimeListingHostScope {
  const covered = new Set<ExecutionHostId>()
  for (const hostId of args.pageHostIds) {
    if (hostId) {
      covered.add(hostId)
    }
  }
  const omitted = new Set<ExecutionHostId>()
  for (const hostId of [...args.matchedHostIds, ...args.knownHostIds]) {
    if (hostId && !covered.has(hostId)) {
      omitted.add(hostId)
    }
  }
  return { hostIds: [...covered].sort(), omittedHostIds: [...omitted].sort() }
}
