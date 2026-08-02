import type { DiffComment, MobileDiffReviewState } from '../../../src/shared/types'
import type { MobileGitBranchCompareResult } from '../source-control/mobile-branch-compare'
import type { MobileGitStatusResult } from '../source-control/mobile-git-status'
import type { MobileDiffLine } from './mobile-diff-lines'
import type { MobileDiffHunk } from './mobile-diff-hunks'
import type {
  MobileDiffReviewQueueFilter,
  MobileDiffReviewQueueItem
} from './mobile-diff-review-queue'
import type { MobileDiffReviewFileDescriptor } from './mobile-diff-review-state'
import type { MobileHighlightedDiffLine } from './mobile-file-syntax'
import type { MobileReviewTerminalTab } from './mobile-diff-review-rpc'

export type ReviewScreenState =
  | { kind: 'loading' }
  | {
      kind: 'ready'
      status: MobileGitStatusResult
      branchCompare: MobileGitBranchCompareResult | null
      branchError?: string
      comments: DiffComment[]
      reviewState: MobileDiffReviewState
    }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string }

export type ReviewDiffLine = MobileHighlightedDiffLine<MobileDiffLine>

export type ReviewDiffState =
  | { kind: 'idle' }
  | { kind: 'loading'; itemKey: string }
  | {
      kind: 'ready'
      itemKey: string
      lines: ReviewDiffLine[]
      hunks: MobileDiffHunk[]
      truncated: boolean
    }
  | { kind: 'binary'; itemKey: string }
  | { kind: 'too-large'; itemKey: string; byteLength?: number }
  | { kind: 'deleted'; itemKey: string }
  | { kind: 'error'; itemKey: string; message: string }

export type ComposerState =
  | { mode: 'create'; lineNumber: number }
  | { mode: 'edit'; comment: DiffComment }

export type SendSheetState =
  | { kind: 'loading' }
  | { kind: 'ready'; terminals: MobileReviewTerminalTab[] }
  | { kind: 'error'; message: string; terminals: MobileReviewTerminalTab[] }

export type GitMutationMethod = 'git.stage' | 'git.unstage' | 'git.discard'

export const REVIEW_FILTERS: MobileDiffReviewQueueFilter[] = [
  'all',
  'unreviewed',
  'notes',
  'unstaged',
  'staged',
  'branch'
]

export function firstReviewParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export function normalizeReviewFilterParam(value: string): MobileDiffReviewQueueFilter {
  return REVIEW_FILTERS.includes(value as MobileDiffReviewQueueFilter)
    ? (value as MobileDiffReviewQueueFilter)
    : 'all'
}

export function reviewDescriptorFromItem(
  item: MobileDiffReviewQueueItem
): MobileDiffReviewFileDescriptor {
  return {
    key: item.key,
    filePath: item.filePath,
    oldPath: item.oldPath,
    scope: item.scope,
    diffIdentity: item.diffIdentity
  }
}

export function nextReviewIndexAfterMarkReviewed({
  currentIndex,
  currentItemKey,
  filter,
  filteredQueue
}: {
  currentIndex: number
  currentItemKey: string
  filter: MobileDiffReviewQueueFilter
  filteredQueue: readonly MobileDiffReviewQueueItem[]
}): number | null {
  const nextIndex = filteredQueue.findIndex(
    (item, index) => index > currentIndex && item.key !== currentItemKey && !item.isReviewed
  )
  const wrappedIndex = filteredQueue.findIndex(
    (item) => item.key !== currentItemKey && !item.isReviewed
  )
  const targetIndex = nextIndex >= 0 ? nextIndex : wrappedIndex >= 0 ? wrappedIndex : null
  if (targetIndex === null) {
    return null
  }
  return filter === 'unreviewed' && targetIndex > currentIndex ? targetIndex - 1 : targetIndex
}

export function mobileReviewScopeLabel(item: MobileDiffReviewQueueItem): string {
  if (item.scope === 'branch') {
    return 'Branch'
  }
  return item.scope === 'staged' ? 'Staged' : 'Unstaged'
}

export function mobileReviewCountLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}
