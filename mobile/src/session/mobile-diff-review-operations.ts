import { bindDeferredRpcOperation, defineRpcOperation } from '../transport/rpc-operation'
import type { RpcCompatibleReader } from '../transport/rpc-operation-contract'
import { rpcResultVariant } from '../transport/rpc-operation-result-reader'
import type { MobileGitBranchCompareResult } from '../source-control/mobile-branch-compare'
import { gitStatusProjectionReader } from '../source-control/mobile-git-read-operations'
import {
  branchCompareProjectionSchema,
  reviewGitDiffSchema,
  reviewWorktreeMetadataSchema
} from './diff-review-reply-schema'

// PR context can fall back from refused status to compare headOid; the review screen instead requires status and reports refusal.
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
  MobileGitBranchCompareResult
> = rpcResultVariant('normalized-branch-compare', branchCompareProjectionSchema)

// Review needs normalized, validated compare data; the Changes reader intentionally preserves the host payload verbatim.
export const reviewBranchCompareRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.review-branch-compare',
    method: 'git.branchCompare',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: branchCompareProjectionReader
  })
)

// Refusal only loses this context’s head-SHA fallback.
export const branchContextCompareRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.branch-context-compare-or-skip',
    method: 'git.branchCompare',
    acceptance: 'success-result-or-skip',
    barrier: 'after-caller-barrier',
    read: branchCompareProjectionReader
  })
)

// Read review notes separately: the summary projection discards them, and both projections are consumed in the same snapshot.
export const reviewWorktreeMetadataRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'worktree.review-metadata',
    method: 'worktree.show',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('review-worktree-metadata', reviewWorktreeMetadataSchema)
  })
)

const reviewDiffReader = rpcResultVariant('review-file-diff', reviewGitDiffSchema)

// Inspect diff_too_large before interpretation because it is a render mode.
export const reviewFileDiffRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.review-file-diff',
    method: 'git.diff',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: reviewDiffReader
  })
)

// Review requires a closed text/binary/too-large result; the Changes preview uses the verbatim payload.
export const reviewBranchFileDiffRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'git.review-branch-file-diff',
    method: 'git.branchDiff',
    acceptance: 'require-result-or-throw-message',
    barrier: 'after-caller-barrier',
    read: reviewDiffReader
  })
)
