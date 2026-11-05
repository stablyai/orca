import type { DiffComment, MobileDiffReviewState } from '../../../src/shared/diff-comment-types'
import type { MobileGitBranchCompareResult } from '../source-control/mobile-branch-compare'
import type { MobileGitStatusResult } from '../source-control/mobile-git-status'
import type { MobileGitChangedFile } from '../source-control/git-compare-reply-schema'
import type { MobileDiffLine } from './mobile-diff-lines'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { MobileDiffReviewFileDescriptor } from './mobile-diff-review-state'
import type { MobileHighlightedDiffLine } from './mobile-file-syntax'
import type { MobileReviewTerminalTab } from './review-terminal-reply-schema'
import { translate } from '../i18n/mobile-i18n'

export type ReviewScreenState =
  | { kind: 'loading' }
  | {
      kind: 'ready'
      status: MobileGitStatusResult
      branchCompare: MobileGitBranchCompareResult | null
      branchError?: string
      /** Set when the screen shows one commit's files instead of the worktree's changes. */
      commit?: MobileDiffReviewCommit
      comments: DiffComment[]
      reviewState: MobileDiffReviewState
    }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string }

export type MobileDiffReviewCommit = {
  commitOid: string
  parentOid: string | null
  entries: MobileGitChangedFile[]
}

export type ReviewDiffLine = MobileHighlightedDiffLine<MobileDiffLine>

export type ReviewDiffState =
  | { kind: 'idle' }
  | { kind: 'loading'; itemKey: string }
  | {
      kind: 'ready'
      itemKey: string
      lines: ReviewDiffLine[]
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

export function firstReviewParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

/** Viewed state and notes track the worktree's changes; a commit's files have neither. */
export function reviewDescriptorFromItem(
  item: MobileDiffReviewQueueItem
): MobileDiffReviewFileDescriptor | null {
  if (item.scope === 'commit') {
    return null
  }
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
  filteredQueue
}: {
  currentIndex: number
  currentItemKey: string
  filteredQueue: readonly MobileDiffReviewQueueItem[]
}): number | null {
  const nextIndex = filteredQueue.findIndex(
    (item, index) => index > currentIndex && item.key !== currentItemKey && !item.isReviewed
  )
  const wrappedIndex = filteredQueue.findIndex(
    (item) => item.key !== currentItemKey && !item.isReviewed
  )
  return nextIndex !== -1 ? nextIndex : wrappedIndex !== -1 ? wrappedIndex : null
}

/** "3 of 12 · 4 viewed" for files that can be viewed, "1 of 4 uncommitted" for files that are staged instead. */
export function mobileDiffReviewPositionLabel({
  scope,
  position,
  count,
  viewedCount
}: {
  scope: MobileDiffReviewQueueItem['scope']
  position: number
  count: number
  viewedCount: number
}): string {
  if (scope === 'unstaged') {
    return translate(
      'session.diffReviewScreenModel.positionUncommitted',
      '{{position}} of {{count}} uncommitted',
      { position, count }
    )
  }
  if (scope === 'commit') {
    return translate(
      'session.diffReviewScreenModel.positionInCommit',
      '{{position}} of {{count}} in this commit',
      { position, count }
    )
  }
  return translate(
    'session.diffReviewScreenModel.positionViewed',
    '{{position}} of {{count}} · {{viewedCount}} viewed',
    { position, count, viewedCount }
  )
}

/** The jump-to-file sheet's subtitle: what is left in this section. */
export function mobileDiffReviewFilesSubtitle({
  scope,
  count,
  viewedCount
}: {
  scope: MobileDiffReviewQueueItem['scope'] | null
  count: number
  viewedCount: number
}): string {
  if (scope === 'commit') {
    return count === 1
      ? translate('session.diffReviewScreenModel.commitFiles_one', '{{count}} file', { count })
      : translate('session.diffReviewScreenModel.commitFiles_other', '{{count}} files', { count })
  }
  if (scope === 'unstaged') {
    return count === 1
      ? translate('session.diffReviewScreenModel.uncommittedFiles_one', '{{count}} uncommitted', {
          count
        })
      : translate('session.diffReviewScreenModel.uncommittedFiles_other', '{{count}} uncommitted', {
          count
        })
  }
  return translate(
    'session.diffReviewScreenModel.viewedOfCount',
    '{{viewedCount}} of {{count}} viewed',
    {
      viewedCount,
      count
    }
  )
}

export function mobileReviewScopeLabel(item: MobileDiffReviewQueueItem): string {
  if (item.scope === 'branch') {
    return translate('session.diffReviewScreenModel.branch', 'Branch')
  }
  return item.scope === 'staged'
    ? translate('session.diffReviewScreenModel.staged', 'Staged')
    : translate('session.diffReviewScreenModel.unstaged', 'Unstaged')
}

export function mobileReviewCountLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}
