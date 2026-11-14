import type { QueryClient } from '@tanstack/react-query'
import { defineHostQuery, fetchHostQuery } from '../../query/host-query'
import { hostQueryKey, type HostQueryTarget } from '../../query/host-query-key'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import { gitStatusQuery } from '../changes/mobile-git-status-query'
import type {
  BranchCompareLoadResult,
  MobileBranchCompareCache
} from './mobile-diff-review-loaders'

export type ReviewBranchCompareKey = { baseRef: string; head: string }

// Read by Review with the base ref it resolved. A desktop git change can move the base and leave status as it was,
// so the change that re-reads status also marks these stale.
const reviewBranchCompareQuery = defineHostQuery<ReviewBranchCompareKey, BranchCompareLoadResult>({
  family: 'git.branchCompare',
  signal: gitStatusQuery.signal
})

type ReviewBuild = {
  isCurrent: () => boolean
  // A compare a git change marked as it landed: newer than the shown one, and being read again.
  onStale: (loaded: BranchCompareLoadResult) => void
  // The compare the build read, once it settles; until then the build reads it again itself after a git change.
  onSettled: (key: ReviewBranchCompareKey) => void
}

// The branch compare cache one Review build reads through. A superseded build's compare is never shown.
export function reviewBuildBranchCompareCache(
  queryClient: QueryClient,
  host: { hostId: string; client: RpcClient },
  target: HostQueryTarget,
  build: ReviewBuild
): MobileBranchCompareCache {
  const { isCurrent, onStale } = build
  return async (key, read) => {
    if (!isCurrent()) {
      return { result: null }
    }
    try {
      const loaded = await fetchHostQuery(
        queryClient,
        reviewBranchCompareQuery,
        host,
        target,
        key,
        {
          read,
          isCurrent,
          onStale
        }
      )
      // Only a compare that landed for this head is worth reusing; cached status can trail a commit.
      // A superseded build's answer may predate the entry a newer build is reading, so only the current one evicts.
      if (isCurrent() && loaded.result?.summary.headOid !== key.head) {
        queryClient.removeQueries({
          queryKey: hostQueryKey(host.hostId, reviewBranchCompareQuery.family, target, key),
          exact: true
        })
      }
      return loaded
    } finally {
      if (isCurrent()) {
        build.onSettled(key)
      }
    }
  }
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
