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
  readMobileBranchCompareResult,
  readMobileGitStatusResult,
  readMobileReviewGitDiffResult,
  readMobileReviewWorktreeMetadata
} from './mobile-diff-review-rpc'
import {
  canOpenMobileBranchCompareDiff,
  type MobileGitBranchCompareResult
} from '../source-control/mobile-branch-compare'
import { resolveMobileBranchCompareBaseRef } from '../source-control/mobile-branch-base-ref'
import { isMobileGitUnavailable } from '../source-control/mobile-git-status'
import type { RpcClient } from '../transport/rpc-client'
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

export async function loadMobileDiffReviewBranchCompare(
  client: RpcClient,
  worktreeId: string
): Promise<BranchCompareLoadResult> {
  try {
    const baseRef = await resolveMobileBranchCompareBaseRef(client, worktreeId)
    if (!baseRef) {
      return { result: null }
    }
    const response = await client.sendRequest('git.branchCompare', {
      worktree: `id:${worktreeId}`,
      baseRef
    })
    if (!response.ok) {
      if (isMobileGitUnavailable(response.error?.code, response.error?.message)) {
        return { result: null }
      }
      return { result: null, error: response.error?.message || 'Committed changes unavailable' }
    }
    const parsed = readMobileBranchCompareResult(response.result)
    return parsed
      ? { result: parsed }
      : { result: null, error: 'Committed changes response was invalid' }
  } catch (err) {
    return { result: null, error: err instanceof Error ? err.message : 'Committed changes failed' }
  }
}

export async function loadMobileDiffReviewSnapshot(
  client: RpcClient,
  worktreeId: string
): Promise<ReviewScreenState> {
  const statusResponse = await client.sendRequest('git.status', { worktree: `id:${worktreeId}` })
  if (!statusResponse.ok) {
    if (isMobileGitUnavailable(statusResponse.error?.code, statusResponse.error?.message)) {
      return { kind: 'unavailable', message: 'Update Orca desktop to review changes on mobile.' }
    }
    throw new Error(statusResponse.error?.message || 'Unable to load changes')
  }
  const status = readMobileGitStatusResult(statusResponse.result)
  if (!status) {
    throw new Error('Source control response was invalid')
  }

  const [branch, worktreeResponse] = await Promise.all([
    loadMobileDiffReviewBranchCompare(client, worktreeId),
    client.sendRequest('worktree.show', { worktree: `id:${worktreeId}` })
  ])
  if (!worktreeResponse.ok) {
    throw new Error(worktreeResponse.error?.message || 'Unable to load review notes')
  }

  const metadata = readMobileReviewWorktreeMetadata(worktreeResponse.result)
  const comments = normalizeMobileDiffComments(metadata.diffComments, worktreeId)
  const normalizedReviewState = normalizeMobileDiffReviewState(metadata.mobileDiffReview)
  const branchEntries =
    branch.result && canOpenMobileBranchCompareDiff(branch.result.summary)
      ? branch.result.entries
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
  const response =
    item.scope === 'branch'
      ? await loadBranchFileDiff(client, worktreeId, item, branchCompare)
      : await client.sendRequest('git.diff', {
          worktree: `id:${worktreeId}`,
          filePath: item.filePath,
          staged: item.scope === 'staged'
        })
  if (!response.ok) {
    if (item.status === 'deleted') {
      return { kind: 'deleted', itemKey: item.key }
    }
    throw new Error(response.error?.message || 'Unable to load diff')
  }
  const result = readMobileReviewGitDiffResult(response.result)
  if (!result) {
    throw new Error('Diff response was invalid')
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

async function loadBranchFileDiff(
  client: RpcClient,
  worktreeId: string,
  item: MobileDiffReviewQueueItem,
  branchCompare: MobileGitBranchCompareResult | null
) {
  const summary = branchCompare?.summary
  if (!summary || !summary.headOid || !summary.mergeBase) {
    throw new Error('Committed diff is unavailable')
  }
  return client.sendRequest('git.branchDiff', {
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
}
