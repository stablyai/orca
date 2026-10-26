import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { selectHostBalancedPage } from '../../shared/host-balanced-listing-page'
import type { RuntimeListingHostScope } from '../../shared/runtime-listing-host-scope'

/** Balance capped pages across hosts; otherwise late-sorting SSH rows vanish and absence looks like an empty host (#18104; ssh-execution-boundary.md). */
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

/** Report covered and omitted hosts, including configured hosts whose scans failed. */
export function buildWorktreeListingHostScope(args: {
  pageHostIds: Iterable<ExecutionHostId | undefined>
  matchedHostIds: Iterable<ExecutionHostId | undefined>
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

/** For a scoped listing, include its requested host even when the scan yields no rows; otherwise scan failure looks byte-identical to an empty repo. Exclude unrelated hosts. */
export function listingKnownHostIds(
  scopedRepo: Repo | null,
  listKnownHostIds: () => Iterable<ExecutionHostId>
): Iterable<ExecutionHostId> {
  return scopedRepo ? [getRepoExecutionHostId(scopedRepo)] : listKnownHostIds()
}
