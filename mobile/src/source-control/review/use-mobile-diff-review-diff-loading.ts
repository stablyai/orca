import { useEffect, useState } from 'react'
import { hashKey, useQueryClient } from '@tanstack/react-query'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  loadMobileDiffReviewDiff,
  mobileReviewDiffInput,
  type MobileReviewDiffInput
} from './mobile-diff-review-loaders'
import { shouldIgnoreTrimWhitespace } from '../../../../src/shared/diff-whitespace'
import { useMobileSourceControlSettings } from '../settings/mobile-source-control-settings'
import { defineHostQuery, prefetchHostQuery, useHostQuery } from '../../query/host-query'
import type { HostQueryTarget } from '../../query/host-query-key'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import { moveMobileDiffReviewSelection } from './mobile-diff-review-selection'
import type { ReviewDiffState, ReviewScreenState } from './mobile-diff-review-screen-model'

const fetchReviewDiff = (
  client: RpcClient,
  target: HostQueryTarget,
  input: MobileReviewDiffInput
) => loadMobileDiffReviewDiff(client, target.worktree ?? '', input)

// Branch and commit diffs are named by their oids, so a cached answer never goes stale.
// `deleted` is the loader's stand-in for a refused read, which may be transient, so it is read again.
const fixedDiffQuery = defineHostQuery({
  family: 'git.diff',
  staleTime: (query) => (query.state.data?.kind === 'deleted' ? 0 : Infinity),
  gcTime: 5 * 60_000,
  fetch: fetchReviewDiff
})

// Worktree files move under agents: a seen diff paints at once and is read again behind it.
const worktreeDiffQuery = defineHostQuery({
  family: 'git.diff',
  staleTime: 0,
  gcTime: 5 * 60_000,
  fetch: fetchReviewDiff
})

type DiffLoadingInput = {
  hostId: string
  client: RpcClient | null
  connState: ConnectionState
  target: HostQueryTarget
  currentItem: MobileDiffReviewQueueItem | null
  /** The files Next and Previous step through, and where the open one sits. */
  filteredQueue: readonly MobileDiffReviewQueueItem[]
  currentIndex: number
  screenState: ReviewScreenState
  /** When the status read behind the queue landed; worktree diffs from an older read are not reused. */
  statusRevision: number
}

// Seen files reopen from the document's cache; a loaded diff stays through transport blips.
export function useMobileDiffReviewDiffLoading(input: DiffLoadingInput): ReviewDiffState {
  const t = useMobileTranslation()
  const { hostId, client, connState, target, currentItem, filteredQueue, currentIndex } = input
  const { screenState, statusRevision } = input
  const { diffShowWhitespace } = useMobileSourceControlSettings(hostId, client, connState).settings
  const queryClient = useQueryClient()
  // useHostQuery keys by value, so a viewed tick that rebuilds the item reuses the same diff.
  const diffInputFor = (item: MobileDiffReviewQueueItem | null) =>
    item && screenState.kind === 'ready'
      ? mobileReviewDiffInput(item, {
          branchCompare: screenState.branchCompare,
          commit: screenState.commit ?? null,
          statusRevision,
          ignoreTrimWhitespace: shouldIgnoreTrimWhitespace(diffShowWhitespace)
        })
      : null
  const diffInput = diffInputFor(currentItem)
  const connected = connState === 'connected'
  const diff = useHostQuery(
    diffInput !== null && diffInput.statusRevision !== null ? worktreeDiffQuery : fixedDiffQuery,
    { hostId, client },
    target,
    diffInput ?? NO_DIFF,
    { enabled: diffInput !== null && connected }
  )
  // Once the open file has painted, read the files Next and Previous lead to so a step paints at once.
  const neighbours = currentItem
    ? (['next', 'previous'] as const).flatMap((direction) => {
        const { index } = moveMobileDiffReviewSelection(
          filteredQueue,
          { key: currentItem.key, index: currentIndex },
          direction
        )
        return diffInputFor(filteredQueue[index] ?? null) ?? []
      })
    : []
  const settled = connected && diff.data !== undefined && !diff.isFetching
  const neighboursKey = hashKey([target, neighbours])
  useEffect(() => {
    if (!settled || !client) {
      return
    }
    for (const neighbour of neighbours) {
      // Both diff queries share a key and loader; a prefetch only fills a key with no current data.
      void prefetchHostQuery(queryClient, fixedDiffQuery, { hostId, client }, target, neighbour)
    }
  }, [settled, client, hostId, queryClient, neighboursKey])
  // A newer status read re-keys the open file's diff; keep its lines on screen until the new answer lands.
  const [lastShown, setLastShown] = useState<ReviewDiffState | null>(null)
  if (diff.data && diff.data !== lastShown) {
    setLastShown(diff.data)
  }

  if (!currentItem || !diffInput) {
    return { kind: 'idle' }
  }
  const itemKey = currentItem.key
  // Older lines stand in only while the new read is out or the desktop is away, never for a failed one.
  const failed = connected && diff.error !== null && !diff.isFetching
  const shown =
    diff.data ??
    (!failed && lastShown && 'itemKey' in lastShown && lastShown.itemKey === itemKey
      ? lastShown
      : undefined)
  if (shown) {
    return shown
  }
  if (!connected) {
    return {
      kind: 'error',
      itemKey,
      message: t('session.useDiffReviewDiffLoading.waitingForDesktop', 'Waiting for desktop...')
    }
  }
  if (diff.error && !diff.isFetching) {
    return {
      kind: 'error',
      itemKey,
      message:
        diff.error.message ||
        t('session.useDiffReviewDiffLoading.loadFailed', 'Unable to load diff')
    }
  }
  return { kind: 'loading', itemKey }
}

const NO_DIFF: MobileReviewDiffInput = {
  itemKey: '',
  scope: 'unstaged',
  filePath: '',
  oldPath: null,
  deleted: false,
  statusRevision: null,
  baseRef: null,
  baseOid: null,
  headOid: null,
  mergeBase: null,
  commitOid: null,
  parentOid: null,
  ignoreTrimWhitespace: false
}
