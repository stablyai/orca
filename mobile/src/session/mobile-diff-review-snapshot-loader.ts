import { buildMobileDiffReviewQueue } from './mobile-diff-review-queue'
import {
  mergeMobileDiffReviewState,
  normalizeMobileDiffReviewState
} from './mobile-diff-review-state'
import { normalizeMobileDiffComments } from './mobile-diff-comments'
import { reviewWorktreeMetadataRead } from './mobile-diff-review-operations'
import { canOpenMobileBranchCompareDiff } from '../source-control/mobile-branch-compare'
import type { MobileBranchCompareTarget } from '../source-control/mobile-branch-base-ref'
import type { GitStatusRead } from '../source-control/mobile-git-status-query'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import { reviewDescriptorFromItem } from './mobile-diff-review-screen-model'
import { translate } from '../i18n/mobile-i18n'
import {
  loadMobileDiffReviewBranchCompare,
  type BranchCompareLoadResult,
  type MobileBranchCompareCache
} from './mobile-diff-review-loaders'

export type MobileDiffReviewSnapshotInput = {
  // The shared `git.status` read Changes also shows.
  status: Promise<GitStatusRead>
  // Compare against the same base the Changes list just showed.
  compareAgainstUpstream: boolean
  cacheBranchCompare?: MobileBranchCompareCache
}

// The worktree's changes and notes settle `snapshot`; the branch compare settles apart so a worktree file need not wait for it.
export function startMobileDiffReviewSnapshot(
  client: RpcClient,
  worktreeId: string,
  input: MobileDiffReviewSnapshotInput
): { snapshot: Promise<ReviewScreenState>; branch: Promise<BranchCompareLoadResult> } {
  // One worktree read serves both the notes and the compare base.
  const worktreeShow = reviewWorktreeMetadataRead.request(client, { worktree: `id:${worktreeId}` })
  const status = input.status
  // The compare base waits for status only when it is the branch's upstream.
  const compareTarget: Promise<MobileBranchCompareTarget | null> = input.compareAgainstUpstream
    ? status.then((read) =>
        read.kind === 'ready'
          ? {
              compareAgainstUpstream: true,
              upstreamName: read.status.upstreamStatus?.upstreamName
            }
          : null
      )
    : Promise.resolve({ compareAgainstUpstream: false })
  const branch = compareTarget.then(
    (compare): Promise<BranchCompareLoadResult> | BranchCompareLoadResult =>
      compare
        ? loadMobileDiffReviewBranchCompare(client, worktreeId, compare, {
            worktreeShow,
            head: () =>
              status.then((read) => (read.kind === 'ready' ? read.status.head : undefined)),
            cache: input.cacheBranchCompare
          })
        : { result: null },
    // Status failing fails the snapshot, which reports it.
    (): BranchCompareLoadResult => ({ result: null })
  )
  return {
    snapshot: buildWorktreeSnapshot(worktreeId, status, worktreeShow),
    branch
  }
}

async function buildWorktreeSnapshot(
  worktreeId: string,
  statusRead: Promise<GitStatusRead>,
  worktreeShow: Promise<RpcResponse>
): Promise<ReviewScreenState> {
  // An old desktop answers without git; its worktree read is then unused.
  worktreeShow.catch(() => {})
  const read = await statusRead
  if (read.kind === 'unavailable') {
    return {
      kind: 'unavailable',
      message: translate(
        'session.diffReviewLoaders.desktopUpdateRequired',
        'Update Orca desktop to review changes on mobile.'
      )
    }
  }
  const worktreeReply = await worktreeShow
  let metadata
  try {
    metadata = reviewWorktreeMetadataRead.interpret(worktreeReply)
  } catch (error) {
    throw new Error(
      refusedRpcMessageOrFallback(
        error,
        translate('session.diffReviewLoaders.reviewNotesLoadFailed', 'Unable to load review notes')
      )
    )
  }
  const comments = normalizeMobileDiffComments(metadata.diffComments, worktreeId)
  return withMobileDiffReviewBranch(
    {
      kind: 'ready',
      status: read.status,
      branchCompare: null,
      comments,
      reviewState: normalizeMobileDiffReviewState(metadata.mobileDiffReview)
    },
    { result: null },
    worktreeId
  )
}

// Adds a settled branch compare to a ready snapshot, re-checking viewed marks against the files it now lists.
export function withMobileDiffReviewBranch(
  state: ReviewScreenState,
  branch: BranchCompareLoadResult,
  worktreeId: string
): ReviewScreenState {
  if (state.kind !== 'ready') {
    return state
  }
  const branchEntries =
    branch.result && canOpenMobileBranchCompareDiff(branch.result.summary)
      ? (branch.result.entries ?? [])
      : []
  const queue = buildMobileDiffReviewQueue({
    worktreeId,
    statusEntries: state.status.entries,
    branchEntries,
    branchHeadOid: branch.result?.summary.headOid,
    branchMergeBase: branch.result?.summary.mergeBase,
    comments: state.comments,
    reviewState: state.reviewState
  })
  return {
    ...state,
    branchCompare: branch.result,
    branchError: branch.error,
    reviewState: mergeMobileDiffReviewState(
      state.reviewState,
      queue.flatMap((item) => reviewDescriptorFromItem(item) ?? []),
      Date.now()
    )
  }
}

export async function loadMobileDiffReviewSnapshot(
  client: RpcClient,
  worktreeId: string,
  input: MobileDiffReviewSnapshotInput
): Promise<ReviewScreenState> {
  const { snapshot, branch } = startMobileDiffReviewSnapshot(client, worktreeId, input)
  const [state, loaded] = await Promise.all([snapshot, branch])
  return withMobileDiffReviewBranch(state, loaded, worktreeId)
}
