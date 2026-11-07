import { buildMobileDiffLines } from './mobile-diff-lines'
import { highlightMobileDiffLines, resolveMobileSyntaxLanguage } from './mobile-file-syntax'
import {
  reviewBranchCompareRead,
  reviewBranchFileDiffRead,
  reviewCommitFileDiffRead,
  reviewFileDiffRead
} from './mobile-diff-review-operations'
import type { MobileReviewGitDiffResult } from './diff-review-reply-schema'
import type { MobileGitBranchCompareResult } from '../source-control/mobile-branch-compare'
import {
  resolveMobileBranchCompareBaseRef,
  type MobileBranchCompareTarget
} from '../source-control/mobile-branch-base-ref'
import { isMobileGitUnavailable } from '../source-control/mobile-git-status'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { MobileDiffReviewQueueItem, MobileDiffReviewSection } from './mobile-diff-review-queue'
import type { MobileDiffReviewCommit, ReviewDiffState } from './mobile-diff-review-screen-model'
import { translate } from '../i18n/mobile-i18n'

export type BranchCompareLoadResult = {
  result: MobileGitBranchCompareResult | null
  error?: string
}

// Hands back a compare already read for this base ref and head, or runs `read`.
export type MobileBranchCompareCache = (
  key: { baseRef: string; head: string },
  read: () => Promise<BranchCompareLoadResult>
) => Promise<BranchCompareLoadResult>

// Everything a file diff depends on, so it doubles as the diff's cache key.
export type MobileReviewDiffInput = {
  itemKey: string
  scope: MobileDiffReviewSection
  filePath: string
  oldPath: string | null
  deleted: boolean
  // Worktree diffs move with the files, so they hold only for the status read the queue came from.
  statusRevision: number | null
  baseRef: string | null
  baseOid: string | null
  headOid: string | null
  mergeBase: string | null
  commitOid: string | null
  parentOid: string | null
  ignoreTrimWhitespace: boolean
}

type PendingFileDiff = {
  reply: RpcResponse
  interpret: (reply: RpcResponse) => MobileReviewGitDiffResult
}

export async function loadMobileDiffReviewBranchCompare(
  client: RpcClient,
  worktreeId: string,
  compare?: MobileBranchCompareTarget,
  options?: {
    worktreeShow?: Promise<RpcResponse>
    // Read once the base ref is known, so the compare base never waits on status.
    head?: () => Promise<string | undefined>
    cache?: MobileBranchCompareCache
  }
): Promise<BranchCompareLoadResult> {
  try {
    const baseRef = await resolveMobileBranchCompareBaseRef(
      client,
      worktreeId,
      compare,
      options?.worktreeShow
    )
    if (!baseRef) {
      return { result: null }
    }
    const head = await options?.head?.()
    const read = () => readBranchCompare(client, worktreeId, baseRef)
    return head && options?.cache ? await options.cache({ baseRef, head }, read) : await read()
  } catch (err) {
    // A transport drop surfaces its own message verbatim; only a refusal falls back above.
    return {
      result: null,
      error:
        err instanceof Error
          ? err.message
          : translate(
              'session.diffReviewLoaders.committedChangesFailed',
              'Committed changes failed'
            )
    }
  }
}

async function readBranchCompare(
  client: RpcClient,
  worktreeId: string,
  baseRef: string
): Promise<BranchCompareLoadResult> {
  const reply = await reviewBranchCompareRead.request(client, {
    worktree: `id:${worktreeId}`,
    baseRef
  })
  // Inspect raw refusal to degrade capability gaps; acceptance policies do not carry code/message.
  if (!reply.ok && isMobileGitUnavailable(reply.error?.code, reply.error?.message)) {
    return { result: null }
  }
  try {
    return { result: reviewBranchCompareRead.interpret(reply) }
  } catch (error) {
    return {
      result: null,
      error: refusedRpcMessageOrFallback(
        error,
        translate(
          'session.diffReviewLoaders.committedChangesUnavailable',
          'Committed changes unavailable'
        )
      )
    }
  }
}

export function mobileReviewDiffInput(
  item: MobileDiffReviewQueueItem,
  context: {
    branchCompare: MobileGitBranchCompareResult | null
    commit: MobileDiffReviewCommit | null
    statusRevision: number
    ignoreTrimWhitespace: boolean
  }
): MobileReviewDiffInput {
  const summary = item.scope === 'branch' ? context.branchCompare?.summary : undefined
  const commit = item.scope === 'commit' ? context.commit : null
  return {
    itemKey: item.key,
    scope: item.scope,
    filePath: item.filePath,
    oldPath: item.oldPath ?? null,
    deleted: item.status === 'deleted',
    statusRevision:
      item.scope === 'unstaged' || item.scope === 'staged' ? context.statusRevision : null,
    baseRef: summary?.baseRef ?? null,
    baseOid: summary?.baseOid ?? null,
    headOid: summary?.headOid ?? null,
    mergeBase: summary?.mergeBase ?? null,
    commitOid: commit?.commitOid ?? null,
    parentOid: commit?.parentOid ?? null,
    ignoreTrimWhitespace: context.ignoreTrimWhitespace
  }
}

export async function loadMobileDiffReviewDiff(
  client: RpcClient,
  worktreeId: string,
  input: MobileReviewDiffInput
): Promise<ReviewDiffState> {
  const pending =
    input.scope === 'commit'
      ? await requestCommitFileDiff(client, worktreeId, input)
      : input.scope === 'branch'
        ? await requestBranchFileDiff(client, worktreeId, input)
        : await requestWorktreeFileDiff(client, worktreeId, input)
  if (!pending.reply.ok) {
    // Read the raw code because diff_too_large selects a render mode rather than a failure.
    if (pending.reply.error?.code === 'diff_too_large') {
      return { kind: 'too-large', itemKey: input.itemKey }
    }
    if (input.deleted) {
      return { kind: 'deleted', itemKey: input.itemKey }
    }
  }
  let result: MobileReviewGitDiffResult
  try {
    result = pending.interpret(pending.reply)
  } catch (error) {
    throw new Error(
      refusedRpcMessageOrFallback(
        error,
        translate('session.diffReviewLoaders.diffLoadFailed', 'Unable to load diff')
      )
    )
  }
  if (result.kind === 'binary') {
    return { kind: 'binary', itemKey: input.itemKey }
  }
  if (result.kind === 'too-large') {
    return { kind: 'too-large', itemKey: input.itemKey, byteLength: result.byteLength }
  }
  const diff = buildMobileDiffLines(result.originalContent, result.modifiedContent, {
    ignoreTrimWhitespace: input.ignoreTrimWhitespace
  })
  const language = resolveMobileSyntaxLanguage(input.filePath)
  return {
    kind: 'ready',
    itemKey: input.itemKey,
    lines: highlightMobileDiffLines(diff.lines, language),
    truncated: diff.truncated
  }
}

async function requestWorktreeFileDiff(
  client: RpcClient,
  worktreeId: string,
  input: MobileReviewDiffInput
): Promise<PendingFileDiff> {
  const staged = input.scope === 'staged'
  const reply = await reviewFileDiffRead.request(client, {
    worktree: `id:${worktreeId}`,
    filePath: input.filePath,
    staged,
    ...(staged && input.oldPath ? { oldPath: input.oldPath } : {})
  })
  return { reply, interpret: (settled) => reviewFileDiffRead.interpret(settled) }
}

async function requestBranchFileDiff(
  client: RpcClient,
  worktreeId: string,
  input: MobileReviewDiffInput
): Promise<PendingFileDiff> {
  const { baseRef, baseOid, headOid, mergeBase } = input
  if (!baseRef || !headOid || !mergeBase) {
    throw new Error(
      translate(
        'session.diffReviewLoaders.committedDiffUnavailable',
        'Committed diff is unavailable'
      )
    )
  }
  const reply = await reviewBranchFileDiffRead.request(client, {
    worktree: `id:${worktreeId}`,
    filePath: input.filePath,
    ...(input.oldPath ? { oldPath: input.oldPath } : {}),
    compare: { baseRef, ...(baseOid ? { baseOid } : {}), headOid, mergeBase }
  })
  return { reply, interpret: (settled) => reviewBranchFileDiffRead.interpret(settled) }
}

async function requestCommitFileDiff(
  client: RpcClient,
  worktreeId: string,
  input: MobileReviewDiffInput
): Promise<PendingFileDiff> {
  if (!input.commitOid) {
    throw new Error(
      translate('session.diffReviewLoaders.commitDiffUnavailable', 'Commit diff is unavailable')
    )
  }
  const reply = await reviewCommitFileDiffRead.request(client, {
    worktree: `id:${worktreeId}`,
    filePath: input.filePath,
    commitOid: input.commitOid,
    ...(input.parentOid ? { parentOid: input.parentOid } : {}),
    ...(input.oldPath ? { oldPath: input.oldPath } : {})
  })
  return { reply, interpret: (settled) => reviewCommitFileDiffRead.interpret(settled) }
}
