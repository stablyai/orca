import type { DiffReviewScope } from '../../../src/shared/types'
import type { MobileGitStagingArea } from '../source-control/mobile-git-status'
import {
  createMobileDiffReviewFileKey,
  type MobileDiffReviewQueueItem
} from './mobile-diff-review-queue'

export type MobileDiffReviewTargetArea = MobileGitStagingArea | 'branch'

export type MobileDiffReviewInitialTarget = {
  filePath: string
  area: MobileDiffReviewTargetArea
}

const VALID_TARGET_AREAS = new Set<MobileDiffReviewTargetArea>([
  'unstaged',
  'untracked',
  'staged',
  'branch'
])

function scopeForTargetArea(area: MobileDiffReviewTargetArea): DiffReviewScope {
  return area === 'staged' || area === 'branch' ? area : 'unstaged'
}

export function normalizeReviewAreaParam(value: string): MobileDiffReviewTargetArea | null {
  return VALID_TARGET_AREAS.has(value as MobileDiffReviewTargetArea)
    ? (value as MobileDiffReviewTargetArea)
    : null
}

export function reviewInitialTargetKey(
  target: MobileDiffReviewInitialTarget,
  oldPath?: string
): string {
  return createMobileDiffReviewFileKey(
    scopeForTargetArea(target.area),
    target.area,
    target.filePath,
    oldPath
  )
}

export function findMobileDiffReviewInitialIndex(
  queue: readonly MobileDiffReviewQueueItem[],
  target: MobileDiffReviewInitialTarget | null
): number {
  if (!target || queue.length === 0) {
    return 0
  }
  const index = queue.findIndex((item) => {
    if (item.area !== target.area) {
      return false
    }
    if (item.filePath === target.filePath) {
      return item.key === reviewInitialTargetKey(target, item.oldPath)
    }
    if (item.oldPath === target.filePath) {
      return (
        item.key === reviewInitialTargetKey({ ...target, filePath: item.filePath }, item.oldPath)
      )
    }
    return false
  })
  return Math.max(index, 0)
}
