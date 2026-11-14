// The open file is held by key, so a queue that reloads under the reader (stage, unstage, discard, a viewed save) keeps it.
export type MobileDiffReviewSelection = { key: string | null; index: number }

export const NO_MOBILE_DIFF_REVIEW_SELECTION: MobileDiffReviewSelection = { key: null, index: 0 }

/** Where the selection sits now; a file that left the queue falls to whatever took its place. */
export function resolveMobileDiffReviewSelection(
  queue: readonly { key: string }[],
  selection: MobileDiffReviewSelection
): number {
  if (queue.length === 0) {
    return 0
  }
  if (selection.key !== null) {
    const index = queue.findIndex((item) => item.key === selection.key)
    if (index !== -1) {
      return index
    }
  }
  return Math.min(selection.index, queue.length - 1)
}

export function selectMobileDiffReviewIndex(
  queue: readonly { key: string }[],
  index: number
): MobileDiffReviewSelection {
  return { key: queue[index]?.key ?? null, index }
}

export function moveMobileDiffReviewSelection(
  queue: readonly { key: string }[],
  selection: MobileDiffReviewSelection,
  direction: 'next' | 'previous'
): MobileDiffReviewSelection {
  if (queue.length === 0) {
    return selection
  }
  const current = resolveMobileDiffReviewSelection(queue, selection)
  const next =
    direction === 'next'
      ? (current + 1) % queue.length
      : (current - 1 + queue.length) % queue.length
  return selectMobileDiffReviewIndex(queue, next)
}
