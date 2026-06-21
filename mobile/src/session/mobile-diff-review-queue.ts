import type { DiffComment, DiffReviewScope, MobileDiffReviewState } from '../../../src/shared/types'
import type { MobileGitBranchChangeEntry } from '../source-control/mobile-branch-compare'
import {
  isMobileGitDiscardableEntry,
  isMobileGitStageableEntry,
  type MobileGitFileStatus,
  type MobileGitStagingArea,
  type MobileGitStatusEntry
} from '../source-control/mobile-git-status'
import {
  buildMobileDiffIdentity,
  didMobileDiffReviewFileChangeSinceReview,
  isMobileDiffReviewFileReviewed
} from './mobile-diff-review-state'

export type MobileDiffReviewQueueFilter =
  | 'all'
  | 'unreviewed'
  | 'notes'
  | 'unstaged'
  | 'staged'
  | 'branch'

export type MobileDiffReviewQueueItem = {
  key: string
  scope: DiffReviewScope
  area: MobileGitStagingArea | 'branch'
  filePath: string
  oldPath?: string
  status: MobileGitFileStatus
  title: string
  subtitle: string
  added?: number
  removed?: number
  canStage: boolean
  canUnstage: boolean
  canDiscard: boolean
  isGeneratedOrLockFile: boolean
  diffIdentity: string
  noteCount: number
  unsentNoteCount: number
  staleNoteCount: number
  reviewedAt?: number
  isReviewed: boolean
  changedSinceReview: boolean
}

export type BuildMobileDiffReviewQueueInput = {
  worktreeId: string
  statusEntries: readonly MobileGitStatusEntry[]
  branchEntries: readonly MobileGitBranchChangeEntry[]
  branchHeadOid?: string | null
  branchMergeBase?: string | null
  comments: readonly DiffComment[]
  reviewState: MobileDiffReviewState
}

const SCOPE_SORT_ORDER: Record<DiffReviewScope, number> = {
  unstaged: 0,
  staged: 1,
  branch: 2
}

function scopeForStatusArea(area: MobileGitStagingArea): DiffReviewScope {
  return area === 'staged' ? 'staged' : 'unstaged'
}

export function createMobileDiffReviewFileKey(
  scope: DiffReviewScope,
  area: MobileGitStagingArea | 'branch',
  filePath: string,
  oldPath?: string
): string {
  return [scope, area, oldPath ?? '', filePath].join('\0')
}

function statusEntryIdentity(entry: MobileGitStatusEntry, scope: DiffReviewScope): string {
  return buildMobileDiffIdentity([
    scope,
    entry.area,
    entry.status,
    entry.oldPath ?? '',
    entry.path,
    String(entry.added ?? ''),
    String(entry.removed ?? ''),
    entry.conflictStatus ?? ''
  ])
}

function branchEntryIdentity(
  entry: MobileGitBranchChangeEntry,
  branchHeadOid: string | null | undefined,
  branchMergeBase: string | null | undefined
): string {
  return buildMobileDiffIdentity([
    'branch',
    branchMergeBase ?? '',
    branchHeadOid ?? '',
    entry.status,
    entry.oldPath ?? '',
    entry.path,
    String(entry.added ?? ''),
    String(entry.removed ?? '')
  ])
}

function isGeneratedOrLockFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase()
  return (
    normalized.endsWith('package-lock.json') ||
    normalized.endsWith('pnpm-lock.yaml') ||
    normalized.endsWith('yarn.lock') ||
    normalized.endsWith('bun.lockb') ||
    normalized.endsWith('.lock') ||
    normalized.includes('/dist/') ||
    normalized.includes('/build/') ||
    normalized.includes('/coverage/') ||
    normalized.endsWith('.generated.ts') ||
    normalized.endsWith('.generated.tsx')
  )
}

export function mobileDiffReviewCommentMatchesItem(
  comment: DiffComment,
  item: Pick<MobileDiffReviewQueueItem, 'filePath' | 'oldPath' | 'scope' | 'diffIdentity'>
): boolean {
  if (comment.source === 'markdown' || comment.filePath !== item.filePath) {
    return false
  }
  if (comment.scope !== undefined && comment.scope !== item.scope) {
    return false
  }
  if (comment.oldPath !== undefined && comment.oldPath !== item.oldPath) {
    return false
  }
  return true
}

function queueNoteCounts(
  item: Pick<MobileDiffReviewQueueItem, 'filePath' | 'oldPath' | 'scope' | 'diffIdentity'>,
  comments: readonly DiffComment[]
): { noteCount: number; unsentNoteCount: number; staleNoteCount: number } {
  let noteCount = 0
  let unsentNoteCount = 0
  let staleNoteCount = 0
  for (const comment of comments) {
    if (!mobileDiffReviewCommentMatchesItem(comment, item)) {
      continue
    }
    noteCount += 1
    if (comment.sentAt === undefined) {
      unsentNoteCount += 1
    }
    if (comment.diffIdentity !== undefined && comment.diffIdentity !== item.diffIdentity) {
      staleNoteCount += 1
    }
  }
  return { noteCount, unsentNoteCount, staleNoteCount }
}

function statusEntryToQueueItem(
  entry: MobileGitStatusEntry,
  comments: readonly DiffComment[],
  reviewState: MobileDiffReviewState
): MobileDiffReviewQueueItem {
  const scope = scopeForStatusArea(entry.area)
  const key = createMobileDiffReviewFileKey(scope, entry.area, entry.path, entry.oldPath)
  const diffIdentity = statusEntryIdentity(entry, scope)
  const reviewFileState = reviewState.files[key]
  const counts = queueNoteCounts(
    { filePath: entry.path, oldPath: entry.oldPath, scope, diffIdentity },
    comments
  )
  return {
    key,
    scope,
    area: entry.area,
    filePath: entry.path,
    oldPath: entry.oldPath,
    status: entry.status,
    title: entry.path,
    subtitle: scope === 'staged' ? 'Staged' : 'Unstaged',
    added: entry.added,
    removed: entry.removed,
    canStage: isMobileGitStageableEntry(entry),
    canUnstage: entry.area === 'staged',
    canDiscard: isMobileGitDiscardableEntry(entry) && entry.area !== 'staged',
    isGeneratedOrLockFile: isGeneratedOrLockFile(entry.path),
    diffIdentity,
    ...counts,
    reviewedAt: reviewFileState?.reviewedAt,
    isReviewed: isMobileDiffReviewFileReviewed(reviewFileState, diffIdentity),
    changedSinceReview: didMobileDiffReviewFileChangeSinceReview(reviewFileState, diffIdentity)
  }
}

function branchEntryToQueueItem(
  entry: MobileGitBranchChangeEntry,
  input: BuildMobileDiffReviewQueueInput
): MobileDiffReviewQueueItem {
  const scope: DiffReviewScope = 'branch'
  const key = createMobileDiffReviewFileKey(scope, 'branch', entry.path, entry.oldPath)
  const diffIdentity = branchEntryIdentity(entry, input.branchHeadOid, input.branchMergeBase)
  const reviewFileState = input.reviewState.files[key]
  const counts = queueNoteCounts(
    { filePath: entry.path, oldPath: entry.oldPath, scope, diffIdentity },
    input.comments
  )
  return {
    key,
    scope,
    area: 'branch',
    filePath: entry.path,
    oldPath: entry.oldPath,
    status: entry.status,
    title: entry.path,
    subtitle: 'Committed on branch',
    added: entry.added,
    removed: entry.removed,
    canStage: false,
    canUnstage: false,
    canDiscard: false,
    isGeneratedOrLockFile: isGeneratedOrLockFile(entry.path),
    diffIdentity,
    ...counts,
    reviewedAt: reviewFileState?.reviewedAt,
    isReviewed: isMobileDiffReviewFileReviewed(reviewFileState, diffIdentity),
    changedSinceReview: didMobileDiffReviewFileChangeSinceReview(reviewFileState, diffIdentity)
  }
}

function compareQueueItems(
  first: MobileDiffReviewQueueItem,
  second: MobileDiffReviewQueueItem
): number {
  return (
    SCOPE_SORT_ORDER[first.scope] - SCOPE_SORT_ORDER[second.scope] ||
    Number(first.isGeneratedOrLockFile) - Number(second.isGeneratedOrLockFile) ||
    first.filePath.localeCompare(second.filePath, undefined, { numeric: true })
  )
}

export function buildMobileDiffReviewQueue(
  input: BuildMobileDiffReviewQueueInput
): MobileDiffReviewQueueItem[] {
  return [
    ...input.statusEntries.map((entry) =>
      statusEntryToQueueItem(entry, input.comments, input.reviewState)
    ),
    ...input.branchEntries.map((entry) => branchEntryToQueueItem(entry, input))
  ].sort(compareQueueItems)
}

export function filterMobileDiffReviewQueue(
  queue: readonly MobileDiffReviewQueueItem[],
  filter: MobileDiffReviewQueueFilter
): MobileDiffReviewQueueItem[] {
  switch (filter) {
    case 'unreviewed':
      return queue.filter((item) => !item.isReviewed)
    case 'notes':
      return queue.filter((item) => item.noteCount > 0)
    case 'unstaged':
    case 'staged':
    case 'branch':
      return queue.filter((item) => item.scope === filter)
    case 'all':
      return [...queue]
  }
}
