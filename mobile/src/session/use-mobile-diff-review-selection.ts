import { useCallback, useEffect, useRef, useState } from 'react'
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
  const currentIndex = resolveMobileDiffReviewSelection(filteredQueue, selection)
  const currentItem = filteredQueue[currentIndex] ?? null
  // Remember the file actually showing and where it sits, including the one that replaced a file that left.
  if (currentItem && (currentItem.key !== selection.key || currentIndex !== selection.index)) {
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

  const seededInitialTargetRef = useRef(false)
  const initialTargetKey = initialTarget ? `${initialTarget.area}\0${initialTarget.filePath}` : ''
  useEffect(() => {
    seededInitialTargetRef.current = false
  }, [initialTargetKey])
  useEffect(() => {
    if (seededInitialTargetRef.current || filteredQueue.length === 0) {
      return
    }
    seededInitialTargetRef.current = true
    // Seed the tapped file only once the queue exists.
    setSelection(
      selectMobileDiffReviewIndex(
        filteredQueue,
        findMobileDiffReviewInitialIndex(filteredQueue, initialTarget)
      )
    )
  }, [filteredQueue, initialTarget])

  return { currentIndex, currentItem, selectIndex, selectKey, moveSelection }
}
