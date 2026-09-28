import { buildMobileDiffLines } from './mobile-diff-lines'
import { buildMobileDiffReviewQueue } from './mobile-diff-review-queue'
import {
  mergeMobileDiffReviewState,
  normalizeMobileDiffReviewState
} from './mobile-diff-review-state'
import { normalizeMobileDiffComments } from './mobile-diff-comments'
import { buildMobileDiffHunks } from './mobile-diff-hunks'
import { highlightMobileDiffLines, resolveMobileSyntaxLanguage } from './mobile-file-syntax'
import {
  reviewBranchCompareRead,
  reviewBranchFileDiffRead,
  reviewFileDiffRead,
  reviewWorktreeMetadataRead
} from './mobile-diff-review-operations'
import type { MobileReviewGitDiffResult } from './diff-review-reply-schema'
import {
  canOpenMobileBranchCompareDiff,
  type MobileGitBranchCompareResult
} from '../source-control/mobile-branch-compare'
import { resolveMobileBranchCompareBaseRef } from '../source-control/mobile-branch-base-ref'
import { gitStatusProjectionRead } from '../source-control/mobile-git-read-operations'
import { isMobileGitUnavailable } from '../source-control/mobile-git-status'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { ReviewDiffState, ReviewScreenState } from './mobile-diff-review-screen-model'
import { reviewDescriptorFromItem } from './mobile-diff-review-screen-model'

type BranchCompareLoadResult = {
  result: MobileGitBranchCompareResult | null
  error?: string
}

type DiffLoadInput = {
  client: RpcClient
  worktreeId: string
  item: MobileDiffReviewQueueItem
  branchCompare: MobileGitBranchCompareResult | null
}

/** One settled file diff and the operation that reads it; the two methods share a reader. */
type PendingFileDiff = {
  reply: RpcResponse
  interpret: (reply: RpcResponse) => MobileReviewGitDiffResult
}

export async function loadMobileDiffReviewBranchCompare(
  client: RpcClient,
  worktreeId: string
): Promise<BranchCompareLoadResult> {
  try {
    const baseRef = await resolveMobileBranchCompareBaseRef(client, worktreeId)
    if (!baseRef) {
      return { result: null }
    }
    const reply = await reviewBranchCompareRead.request(client, {
      worktree: `id:${worktreeId}`,
      baseRef
    })
    // Why the raw refusal: a host that does not offer git to mobile is a capability gap this
    // screen degrades on, and no acceptance policy carries the code and message through.
    if (!reply.ok && isMobileGitUnavailable(reply.error?.code, reply.error?.message)) {
      return { result: null }
    }
    // The reader refuses a compare it cannot normalize, so the "response was invalid" branch main
    // kept here is gone: an unreadable compare arrives as the incompatible-reply message instead.
    try {
      return { result: reviewBranchCompareRead.interpret(reply) }
    } catch (error) {
      return {
        result: null,
        error: refusedRpcMessageOrFallback(error, 'Committed changes unavailable')
      }
    }
  } catch (err) {
    // A transport drop surfaces its own message verbatim; only a refusal falls back above.
    return { result: null, error: err instanceof Error ? err.message : 'Committed changes failed' }
  }
}

export async function loadMobileDiffReviewSnapshot(
  client: RpcClient,
  worktreeId: string
): Promise<ReviewScreenState> {
  const statusReply = await gitStatusProjectionRead.request(client, {
    worktree: `id:${worktreeId}`
  })
  if (
    !statusReply.ok &&
    isMobileGitUnavailable(statusReply.error?.code, statusReply.error?.message)
  ) {
    return { kind: 'unavailable', message: 'Update Orca desktop to review changes on mobile.' }
  }
  let status
  try {
    status = gitStatusProjectionRead.interpret(statusReply)
  } catch (error) {
    throw new Error(refusedRpcMessageOrFallback(error, 'Unable to load changes'))
  }
  if (!status) {
    throw new Error('Source control response was invalid')
  }

  // Both legs are interpreted after the barrier, not as each lands: a refused worktree.show must
  // not decide the error before the compare leg has had its own chance to fail.
  const [branch, worktreeReply] = await Promise.all([
    loadMobileDiffReviewBranchCompare(client, worktreeId),
    reviewWorktreeMetadataRead.request(client, { worktree: `id:${worktreeId}` })
  ])
  let metadata
  try {
    metadata = reviewWorktreeMetadataRead.interpret(worktreeReply)
  } catch (error) {
    throw new Error(refusedRpcMessageOrFallback(error, 'Unable to load review notes'))
  }

  const comments = normalizeMobileDiffComments(metadata.diffComments, worktreeId)
  const normalizedReviewState = normalizeMobileDiffReviewState(metadata.mobileDiffReview)
  const branchEntries =
    branch.result && canOpenMobileBranchCompareDiff(branch.result.summary)
      ? (branch.result.entries ?? [])
      : []
  const queue = buildMobileDiffReviewQueue({
    worktreeId,
    statusEntries: status.entries,
    branchEntries,
    branchHeadOid: branch.result?.summary.headOid,
    branchMergeBase: branch.result?.summary.mergeBase,
    comments,
    reviewState: normalizedReviewState
  })

  return {
    kind: 'ready',
    status,
    branchCompare: branch.result,
    branchError: branch.error,
    comments,
    reviewState: mergeMobileDiffReviewState(
      normalizedReviewState,
      queue.map(reviewDescriptorFromItem),
      Date.now()
    )
  }
}

export async function loadMobileDiffReviewDiff(input: DiffLoadInput): Promise<ReviewDiffState> {
  const { client, worktreeId, item, branchCompare } = input
  const pending =
    item.scope === 'branch'
      ? await requestBranchFileDiff(client, worktreeId, item, branchCompare)
      : await requestWorktreeFileDiff(client, worktreeId, item)
  if (!pending.reply.ok) {
    // Why the raw refusal: `diff_too_large` is a render mode rather than a failure, and no
    // acceptance policy carries the code through.
    if (pending.reply.error?.code === 'diff_too_large') {
      return { kind: 'too-large', itemKey: item.key }
    }
    if (item.status === 'deleted') {
      return { kind: 'deleted', itemKey: item.key }
    }
  }
  let result: MobileReviewGitDiffResult
  try {
    result = pending.interpret(pending.reply)
  } catch (error) {
    throw new Error(refusedRpcMessageOrFallback(error, 'Unable to load diff'))
  }
  if (result.kind === 'binary') {
    return { kind: 'binary', itemKey: item.key }
  }
  if (result.kind === 'too-large') {
    return { kind: 'too-large', itemKey: item.key, byteLength: result.byteLength }
  }
  const diff = buildMobileDiffLines(result.originalContent, result.modifiedContent)
  const language = resolveMobileSyntaxLanguage(item.filePath)
  return {
    kind: 'ready',
    itemKey: item.key,
    lines: highlightMobileDiffLines(diff.lines, language),
    hunks: buildMobileDiffHunks(diff.lines),
    truncated: diff.truncated
  }
}

async function requestWorktreeFileDiff(
  client: RpcClient,
  worktreeId: string,
  item: MobileDiffReviewQueueItem
): Promise<PendingFileDiff> {
  const reply = await reviewFileDiffRead.request(client, {
    worktree: `id:${worktreeId}`,
    filePath: item.filePath,
    staged: item.scope === 'staged'
  })
  return { reply, interpret: (settled) => reviewFileDiffRead.interpret(settled) }
}

async function requestBranchFileDiff(
  client: RpcClient,
  worktreeId: string,
  item: MobileDiffReviewQueueItem,
  branchCompare: MobileGitBranchCompareResult | null
): Promise<PendingFileDiff> {
  const summary = branchCompare?.summary
  if (!summary || !summary.headOid || !summary.mergeBase) {
    throw new Error('Committed diff is unavailable')
  }
  const reply = await reviewBranchFileDiffRead.request(client, {
    worktree: `id:${worktreeId}`,
    filePath: item.filePath,
    ...(item.oldPath ? { oldPath: item.oldPath } : {}),
    compare: {
      baseRef: summary.baseRef,
      ...(summary.baseOid ? { baseOid: summary.baseOid } : {}),
      headOid: summary.headOid,
      mergeBase: summary.mergeBase
    }
  })
  return { reply, interpret: (settled) => reviewBranchFileDiffRead.interpret(settled) }
}
