import { useCallback, useState } from 'react'
import {
  findMobileDiffReviewInitialIndex,
  type MobileDiffReviewInitialTarget
} from './mobile-diff-review-positioning'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import {
  moveMobileDiffReviewSelection,
  NO_MOBILE_DIFF_REVIEW_SELECTION,
  resolveMobileDiffReviewSelection,
  selectMobileDiffReviewIndex,
  type MobileDiffReviewSelection
} from './mobile-diff-review-selection'

/** The open file in the section's queue, held by key across reloads; starts on the tapped file. */
export function useMobileDiffReviewSelection(
  filteredQueue: readonly MobileDiffReviewQueueItem[],
  initialTarget: MobileDiffReviewInitialTarget | null
) {
  const [selection, setSelection] = useState<MobileDiffReviewSelection>(
    NO_MOBILE_DIFF_REVIEW_SELECTION
  )
  // Seed the tapped file in the render the queue first exists, so no other file is ever current or read.
  const initialTargetKey = initialTarget ? `${initialTarget.area}\0${initialTarget.filePath}` : ''
  const [seededTargetKey, setSeededTargetKey] = useState<string | null>(null)
  let held = selection
  if (filteredQueue.length > 0 && seededTargetKey !== initialTargetKey) {
    held = selectMobileDiffReviewIndex(
      filteredQueue,
      findMobileDiffReviewInitialIndex(filteredQueue, initialTarget)
    )
    setSeededTargetKey(initialTargetKey)
    setSelection(held)
  }
  const currentIndex = resolveMobileDiffReviewSelection(filteredQueue, held)
  const currentItem = filteredQueue[currentIndex] ?? null
  // Remember the file actually showing and where it sits, including the one that replaced a file that left.
  if (currentItem && (currentItem.key !== held.key || currentIndex !== held.index)) {
    setSelection({ key: currentItem.key, index: currentIndex })
  }
  const selectIndex = useCallback(
    (index: number) => setSelection(selectMobileDiffReviewIndex(filteredQueue, index)),
    [filteredQueue]
  )
  const selectKey = useCallback(
    (key: string) => setSelection((prev) => ({ key, index: prev.index })),
    []
  )
  const moveSelection = useCallback(
    (direction: 'next' | 'previous') =>
      setSelection((prev) => moveMobileDiffReviewSelection(filteredQueue, prev, direction)),
    [filteredQueue]
  )

  return { currentIndex, currentItem, selectIndex, selectKey, moveSelection }
}
