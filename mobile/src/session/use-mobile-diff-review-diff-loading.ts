import { translate } from '../i18n/mobile-i18n'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import {
  loadMobileDiffReviewDiff,
  mobileReviewDiffInput,
  type MobileReviewDiffInput
} from './mobile-diff-review-loaders'
import { shouldIgnoreTrimWhitespace } from '../../../src/shared/diff-whitespace'
import { useMobileSourceControlSettings } from '../source-control/mobile-source-control-settings'
import { defineHostQuery, useHostQuery } from '../query/host-query'
import type { HostQueryTarget } from '../query/host-query-key'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { ReviewDiffState, ReviewScreenState } from './mobile-diff-review-screen-model'

// The input names the diff's content (oids, or the status read for worktree files), so a cached answer never goes stale.
const reviewDiffQuery = defineHostQuery({
  family: 'git.diff',
  staleTime: Infinity,
  gcTime: 5 * 60_000,
  fetch: (client, target, input: MobileReviewDiffInput) =>
    loadMobileDiffReviewDiff(client, target.worktree ?? '', input)
})

type DiffLoadingInput = {
  hostId: string
  client: RpcClient | null
  connState: ConnectionState
  target: HostQueryTarget
  currentItem: MobileDiffReviewQueueItem | null
  screenState: ReviewScreenState
  /** When the status read behind the queue landed; worktree diffs from an older read are not reused. */
  statusRevision: number
}

// Seen files reopen from the document's cache; a loaded diff stays through transport blips.
export function useMobileDiffReviewDiffLoading(input: DiffLoadingInput): ReviewDiffState {
  useMobileTranslation()
  const { hostId, client, connState, target, currentItem, screenState, statusRevision } = input
  const { diffShowWhitespace } = useMobileSourceControlSettings(hostId, client, connState).settings
  // useHostQuery keys by value, so a viewed tick that rebuilds the item reuses the same diff.
  const diffInput =
    currentItem && screenState.kind === 'ready'
      ? mobileReviewDiffInput(currentItem, {
          branchCompare: screenState.branchCompare,
          commit: screenState.commit ?? null,
          statusRevision,
          ignoreTrimWhitespace: shouldIgnoreTrimWhitespace(diffShowWhitespace)
        })
      : null
  const connected = connState === 'connected'
  const diff = useHostQuery(reviewDiffQuery, { hostId, client }, target, diffInput ?? NO_DIFF, {
    enabled: diffInput !== null && connected
  })

  if (!currentItem || !diffInput) {
    return { kind: 'idle' }
  }
  const itemKey = currentItem.key
  if (diff.data) {
    return diff.data
  }
  if (!connected) {
    return {
      kind: 'error',
      itemKey,
      message: translate(
        'session.useDiffReviewDiffLoading.waitingForDesktop',
        'Waiting for desktop...'
      )
    }
  }
  if (diff.error && !diff.isFetching) {
    return {
      kind: 'error',
      itemKey,
      message:
        diff.error.message ||
        translate('session.useDiffReviewDiffLoading.loadFailed', 'Unable to load diff')
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
