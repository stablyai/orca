import type { GitHubPRFile } from '../../../src/shared/github/pull-request-types'
import type { GitHubWorkItemDetails } from '../../../src/shared/github/work-item-types'
import { getPRInlineCommentPlacement } from '../../../src/shared/github/pr-inline-comment-placement'
import { groupPRComments, type PRCommentGroup } from '../../../src/shared/pr-comment-groups'
import type { GitHubPrRepoSlug } from './github-pr-rpc'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'

export type MobileDiffReviewThread = Extract<PRCommentGroup, { kind: 'thread' }>

/** What the diff screen knows about the branch's GitHub pull request. */
export type MobileDiffReviewGitHub = {
  prNumber: number
  prRepo: GitHubPrRepoSlug | null
  pullRequestId: string | null
  headSha: string | null
  /**
   * The local branch is at the PR's head, so local line numbers are GitHub's. Desktop shows threads
   * only on the PR's own contents; the local diff is those contents only when the heads match.
   */
  linesMatch: boolean
  /** Null on hosts that don't send PR files; viewed state then stays on the phone. */
  filesByPath: ReadonlyMap<string, GitHubPRFile> | null
  threadsByPath: ReadonlyMap<string, ReadonlyMap<number, MobileDiffReviewThread[]>>
}

export function buildMobileDiffReviewGitHub(input: {
  prNumber: number
  prRepo: GitHubPrRepoSlug | null
  details: GitHubWorkItemDetails
  localHeadOid: string | null
}): MobileDiffReviewGitHub {
  const { details } = input
  const headSha = details.headSha ?? null
  const threadsByPath = new Map<string, Map<number, MobileDiffReviewThread[]>>()
  for (const group of groupPRComments(details.comments)) {
    if (group.kind !== 'thread') {
      continue
    }
    // Desktop's rule: outdated threads and file-level comments don't sit under a line.
    const placement = getPRInlineCommentPlacement(group.root)
    if (!placement) {
      continue
    }
    const byLine = threadsByPath.get(placement.path) ?? new Map<number, MobileDiffReviewThread[]>()
    byLine.set(placement.line, [...(byLine.get(placement.line) ?? []), group])
    threadsByPath.set(placement.path, byLine)
  }
  return {
    prNumber: input.prNumber,
    prRepo: input.prRepo,
    pullRequestId: details.pullRequestId ?? null,
    headSha,
    linesMatch: headSha !== null && headSha === input.localHeadOid,
    filesByPath: details.files ? new Map(details.files.map((file) => [file.path, file])) : null,
    threadsByPath
  }
}

/**
 * The PR file whose viewed state GitHub owns: GitHub reported it, the PR can be marked, and the
 * local diff is the PR's version (the threads rule); otherwise the phone keeps its own state.
 */
export function gitHubViewedFile(
  github: MobileDiffReviewGitHub | null,
  item: MobileDiffReviewQueueItem
): GitHubPRFile | null {
  if (!github?.pullRequestId || !github.linesMatch || item.scope !== 'branch') {
    return null
  }
  const file = github.filesByPath?.get(item.filePath)
  return file?.viewerViewedState !== undefined ? file : null
}

/** GitHub owns viewed state for the PR's files; DISMISSED means it changed after it was viewed. */
export function applyMobileDiffReviewGitHubViewed(
  queue: readonly MobileDiffReviewQueueItem[],
  github: MobileDiffReviewGitHub | null
): MobileDiffReviewQueueItem[] {
  return queue.map((item) => {
    const file = gitHubViewedFile(github, item)
    return file
      ? {
          ...item,
          isReviewed: file.viewerViewedState === 'VIEWED',
          changedSinceReview: file.viewerViewedState === 'DISMISSED'
        }
      : item
  })
}

/** Whether GitHub takes a review comment on every line of the range: only lines inside the file's diff hunks. */
export function canCommentOnGitHub(
  github: MobileDiffReviewGitHub | null,
  item: MobileDiffReviewQueueItem | null,
  range: { startLine: number; line: number }
): boolean {
  if (!github?.linesMatch || !github.headSha || !item || item.scope !== 'branch') {
    return false
  }
  const commentable = github.filesByPath?.get(item.filePath)?.reviewCommentLineNumbers
  if (!commentable) {
    return false
  }
  const lines = new Set(commentable)
  for (let line = range.startLine; line <= range.line; line += 1) {
    if (!lines.has(line)) {
      return false
    }
  }
  return true
}

const NO_THREADS: ReadonlyMap<number, readonly MobileDiffReviewThread[]> = new Map()

/** The open file's threads by line, or how many are waiting until the branch matches the PR head. */
export function mobileDiffReviewThreadsForItem(
  github: MobileDiffReviewGitHub | null,
  item: MobileDiffReviewQueueItem | null
): {
  threadsByLine: ReadonlyMap<number, readonly MobileDiffReviewThread[]>
  hiddenThreadCount: number
} {
  const byLine =
    github && item?.scope === 'branch' ? github.threadsByPath.get(item.filePath) : undefined
  if (!byLine) {
    return { threadsByLine: NO_THREADS, hiddenThreadCount: 0 }
  }
  if (github?.linesMatch) {
    return { threadsByLine: byLine, hiddenThreadCount: 0 }
  }
  let hiddenThreadCount = 0
  for (const threads of byLine.values()) {
    hiddenThreadCount += threads.length
  }
  return { threadsByLine: NO_THREADS, hiddenThreadCount }
}
