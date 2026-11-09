import type { QueryClient } from '@tanstack/react-query'
import { defineHostQuery, fetchHostQuery } from '../../query/host-query'
import { hostQueryKey, type HostQueryTarget } from '../../query/host-query-key'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { gitStatusQuery } from '../mobile-git-status-query'
import type { BranchCompareLoadResult } from './mobile-diff-review-loaders'

export type ReviewBranchCompareKey = { baseRef: string; head: string }

// Read by Review with the base ref it resolved. A desktop git change can move the base and leave status as it was,
// so the change that re-reads status also marks these stale.
const reviewBranchCompareQuery = defineHostQuery<ReviewBranchCompareKey, BranchCompareLoadResult>({
  family: 'git.branchCompare',
  signal: gitStatusQuery.signal
})

export async function readCachedReviewBranchCompare(
  queryClient: QueryClient,
  host: { hostId: string; client: RpcClient },
  target: HostQueryTarget,
  key: ReviewBranchCompareKey,
  read: () => Promise<BranchCompareLoadResult>
): Promise<BranchCompareLoadResult> {
  const loaded = await fetchHostQuery(
    queryClient,
    reviewBranchCompareQuery,
    host,
    target,
    key,
    read
  )
  // Only a compare that landed for this head is worth reusing; cached status can trail a commit.
  if (loaded.result?.summary.headOid !== key.head) {
    queryClient.removeQueries({
      queryKey: hostQueryKey(host.hostId, reviewBranchCompareQuery.family, target, key),
      exact: true
    })
  }
  return loaded
}

// Marked by a git change and not being read again, so only a new build brings the current compare.
export function reviewBranchCompareNeedsRead(
  queryClient: QueryClient,
  hostId: string,
  target: HostQueryTarget,
  key: ReviewBranchCompareKey
): boolean {
  const state = queryClient.getQueryState(
    hostQueryKey(hostId, reviewBranchCompareQuery.family, target, key)
  )
  return state?.isInvalidated === true && state.fetchStatus === 'idle'
}
