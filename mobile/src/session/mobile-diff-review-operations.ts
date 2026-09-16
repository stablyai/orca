import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'
import { rpcReadUnchecked } from '../transport/rpc-reader-payload'
import type { MobileGitBranchCompareResult } from '../source-control/mobile-branch-compare'
import { gitStatusProjectionReader } from '../source-control/mobile-git-read-operations'
import {
  readMobileBranchCompareResult,
  readMobileReviewGitDiffResult,
  readMobileReviewWorktreeMetadata,
  type MobileReviewGitDiffResult,
  type MobileReviewWorktreeMetadata
} from './mobile-diff-review-rpc'

// What the review screen and the PR branch-context loader read. Both work from the same three
// projections — normalized status, normalized branch compare, the review notes on the worktree —
// and neither reads a raw host payload.

/**
 * git.status read for the PR branch context. The third policy on this method, and the only one that
 * skips: the standalone PR entry point derives branch and head SHA from status and falls back to
 * branchCompare's headOid, so a refused status leaves it with no branch rather than an error to
 * show. The review screen's read (`gitStatusProjectionRead`) must surface the message instead,
 * because the screen has nothing to render without it. Both bind the same
 * `gitStatusProjectionReader`; only what a refusal means differs.
 */
export const branchContextStatusRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.branch-context-status-or-skip',
    method: 'git.status',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: gitStatusProjectionReader
  })
)

const branchCompareProjectionReader: RpcCompatibleReader<
  unknown,
  'normalized-branch-compare',
  MobileGitBranchCompareResult | null
> = (raw) => rpcReadUnchecked('normalized-branch-compare', readMobileBranchCompareResult(raw))

/**
 * git.branchCompare, second reader on the method. The Changes screen publishes the host payload
 * verbatim through `gitBranchCompareRead`; this one normalizes. The projection is not a superset —
 * it answers null when `summary` or `entries` is not the expected shape, or when `baseRef`,
 * `compareRef` or `changedFiles` is missing — and review and PR context both depend on that null to
 * report "committed changes response was invalid" rather than rendering a partial compare. Sharing
 * the verbatim reader would hand them a payload they would then have to re-parse.
 */
export const reviewBranchCompareRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.review-branch-compare',
    method: 'git.branchCompare',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: branchCompareProjectionReader
  })
)

/** The same projection, read where a refused compare only costs the head-SHA fallback. */
export const branchContextCompareRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.branch-context-compare-or-skip',
    method: 'git.branchCompare',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: branchCompareProjectionReader
  })
)

const reviewMetadataReader: RpcCompatibleReader<
  unknown,
  'review-worktree-metadata',
  MobileReviewWorktreeMetadata
> = (raw) => rpcReadUnchecked('review-worktree-metadata', readMobileReviewWorktreeMetadata(raw))

/**
 * worktree.show, second reader on the method. `worktreeSummaryRead` projects `{ baseRef, linkedPR }`
 * and drops everything else, so it would answer the review screen with no notes at all for every
 * reply. The two are read side by side in one snapshot — branch-base resolution asks for the
 * summary while the screen asks for the notes — which is why neither can be widened into the other
 * without changing what the other sees.
 */
export const reviewWorktreeMetadataRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.review-metadata',
    method: 'worktree.show',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: reviewMetadataReader
  })
)

const reviewDiffReader: RpcCompatibleReader<
  unknown,
  'review-file-diff',
  MobileReviewGitDiffResult | null
> = (raw) => rpcReadUnchecked('review-file-diff', readMobileReviewGitDiffResult(raw))

/**
 * The worktree file diff. Its refusal carries meaning the acceptance policy cannot: `diff_too_large`
 * is a render mode, not a failure, so the caller reads that code off the raw reply before it
 * interprets — the same raw-refusal read `use-mobile-source-control-loaders.ts` makes for the
 * mobile-git capability gap.
 */
export const reviewFileDiffRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.review-file-diff',
    method: 'git.diff',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: reviewDiffReader
  })
)

/**
 * The committed-range equivalent, second reader on git.branchDiff. `gitBranchDiffRead` hands the
 * Changes screen's branch preview the host payload verbatim; review needs the
 * text/binary/too-large discrimination, and a reply that matches none of the three has to read as
 * null so the screen says the diff was invalid instead of rendering an empty file.
 */
export const reviewBranchFileDiffRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.review-branch-file-diff',
    method: 'git.branchDiff',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: reviewDiffReader
  })
)
