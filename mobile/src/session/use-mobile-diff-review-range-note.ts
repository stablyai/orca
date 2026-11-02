import { useCallback } from 'react'
import type { DiffComment, MobileDiffReviewState } from '../../../src/shared/diff-comment-types'
import { addMobileDiffComment } from './mobile-diff-comments'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'

type Input = {
  worktreeId: string
  screenState: ReviewScreenState
  currentItem: MobileDiffReviewQueueItem | null
  composerBody: string
  saveCommentsAndReviewState: (
    comments: DiffComment[],
    reviewState: MobileDiffReviewState
  ) => Promise<void>
}

/** Saves the range sheet's text as a note on those lines, for the agent; null when there is nothing to save. */
export function useMobileDiffReviewRangeNote(input: Input) {
  const { worktreeId, screenState, currentItem, composerBody, saveCommentsAndReviewState } = input
  return useCallback(
    async (range: {
      startLine: number
      line: number
    }): Promise<{ comment: DiffComment } | { error: string | null }> => {
      const body = composerBody.trim()
      if (!body || !currentItem || screenState.kind !== 'ready' || currentItem.scope === 'commit') {
        return { error: null }
      }
      const now = Date.now()
      const result = addMobileDiffComment(screenState.comments, {
        id: `mobile-${now}-${Math.random().toString(36).slice(2)}`,
        worktreeId,
        filePath: currentItem.filePath,
        oldPath: currentItem.oldPath,
        ...(range.startLine < range.line ? { startLine: range.startLine } : {}),
        lineNumber: range.line,
        body,
        createdAt: now,
        scope: currentItem.scope,
        diffIdentity: currentItem.diffIdentity
      })
      if (!result.comment) {
        return { error: null }
      }
      try {
        await saveCommentsAndReviewState(result.comments, screenState.reviewState)
      } catch (err) {
        // The screen's banner sits under the open sheet, so the sheet shows why nothing was sent.
        return { error: err instanceof Error ? err.message : null }
      }
      return { comment: result.comment }
    },
    [composerBody, currentItem, saveCommentsAndReviewState, screenState, worktreeId]
  )
}
