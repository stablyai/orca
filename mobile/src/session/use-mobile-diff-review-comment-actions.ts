import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { DiffComment, MobileDiffReviewState } from '../../../src/shared/diff-comment-types'
import { triggerError, triggerSuccess } from '../platform/haptics'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import { sessionWorktreeNotesWrite } from './mobile-session-write-operations'
import { addMobileDiffComment, removeMobileDiffComments } from './mobile-diff-comments'
import { updateMobileDiffComment } from './mobile-diff-comment-edit'
import {
  clearMobileDiffReviewFileReviewed,
  completeMobileDiffReviewState,
  markMobileDiffReviewFileReviewed
} from './mobile-diff-review-state'
import type {
  MobileDiffReviewQueueFilter,
  MobileDiffReviewQueueItem
} from './mobile-diff-review-queue'
import type { ComposerState, ReviewScreenState } from './mobile-diff-review-screen-model'
import {
  nextReviewIndexAfterMarkReviewed,
  reviewDescriptorFromItem
} from './mobile-diff-review-screen-model'
import type { ReviewSheetIntents } from './mobile-diff-review-sheets'

type CommentActionsInput = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  screenState: ReviewScreenState
  currentItem: MobileDiffReviewQueueItem | null
  queue: MobileDiffReviewQueueItem[]
  filteredQueue: MobileDiffReviewQueueItem[]
  filter: MobileDiffReviewQueueFilter
  currentIndex: number
  composer: ComposerState | null
  composerBody: string
  setScreenState: Dispatch<SetStateAction<ReviewScreenState>>
  setCurrentIndex: Dispatch<SetStateAction<number>>
  setComposerBody: Dispatch<SetStateAction<string>>
  setActionError: Dispatch<SetStateAction<string | null>>
  sheets: Pick<ReviewSheetIntents, 'openSheet' | 'openSheetWhenIdle' | 'closeSheet'>
}

export function useMobileDiffReviewCommentActions(input: CommentActionsInput) {
  const {
    client,
    connState,
    worktreeId,
    screenState,
    currentItem,
    queue,
    filteredQueue,
    filter,
    currentIndex,
    composer,
    composerBody,
    setScreenState,
    setCurrentIndex,
    setComposerBody,
    setActionError,
    sheets
  } = input
  const { openSheet, openSheetWhenIdle, closeSheet } = sheets

  const persistMetadata = useCallback(
    async (comments: readonly DiffComment[], reviewState: MobileDiffReviewState) => {
      if (!client || connState !== 'connected') {
        throw new Error('Waiting for desktop...')
      }
      const response = await sessionWorktreeNotesWrite.request(client, {
        worktree: `id:${worktreeId}`,
        diffComments: [...comments],
        mobileDiffReview: reviewState
      })
      interpretOrThrowRefusalMessage(
        () => sessionWorktreeNotesWrite.interpret(response),
        'Failed to save review state'
      )
    },
    [client, connState, worktreeId]
  )

  const updateReadyState = useCallback(
    (updater: (state: Extract<ReviewScreenState, { kind: 'ready' }>) => ReviewScreenState) => {
      setScreenState((prev) => (prev.kind === 'ready' ? updater(prev) : prev))
    },
    [setScreenState]
  )

  const saveCommentsAndReviewState = useCallback(
    async (comments: DiffComment[], reviewState: MobileDiffReviewState) => {
      const previous = screenState
      updateReadyState((state) => ({ ...state, comments, reviewState }))
      try {
        await persistMetadata(comments, reviewState)
        triggerSuccess()
      } catch (err) {
        if (previous.kind === 'ready') {
          setScreenState(previous)
        }
        triggerError()
        setActionError(err instanceof Error ? err.message : 'Failed to save review')
        throw err
      }
    },
    [persistMetadata, screenState, setActionError, setScreenState, updateReadyState]
  )

  const openComposer = useCallback(
    (lineNumber: number) => {
      openSheet({ kind: 'composer', composer: { mode: 'create', lineNumber } })
      setComposerBody('')
    },
    [openSheet, setComposerBody]
  )

  const openEditComposer = useCallback(
    (comment: DiffComment) => {
      openSheet({ kind: 'composer', composer: { mode: 'edit', comment } })
      setComposerBody(comment.body)
    },
    [openSheet, setComposerBody]
  )

  const closeComposer = useCallback(() => {
    closeSheet('composer')
    setComposerBody('')
  }, [closeSheet, setComposerBody])

  const saveComposer = useCallback(async () => {
    if (!composer || !currentItem || screenState.kind !== 'ready') {
      return
    }
    const now = Date.now()
    const result =
      composer.mode === 'edit'
        ? updateMobileDiffComment(screenState.comments, {
            id: composer.comment.id,
            body: composerBody,
            updatedAt: now
          })
        : addMobileDiffComment(screenState.comments, {
            id: `mobile-${now}-${Math.random().toString(36).slice(2)}`,
            worktreeId,
            filePath: currentItem.filePath,
            oldPath: currentItem.oldPath,
            lineNumber: composer.lineNumber,
            body: composerBody,
            createdAt: now,
            scope: currentItem.scope,
            diffIdentity: currentItem.diffIdentity
          })
    if (!result.comment) {
      return
    }
    await saveCommentsAndReviewState(result.comments, screenState.reviewState)
    closeComposer()
  }, [
    closeComposer,
    composer,
    composerBody,
    currentItem,
    saveCommentsAndReviewState,
    screenState,
    worktreeId
  ])

  const deleteComment = useCallback(async () => {
    if (!composer || composer.mode !== 'edit' || screenState.kind !== 'ready') {
      return
    }
    const nextComments = removeMobileDiffComments(
      screenState.comments,
      new Set([composer.comment.id])
    )
    await saveCommentsAndReviewState(nextComments, screenState.reviewState)
    closeComposer()
  }, [closeComposer, composer, saveCommentsAndReviewState, screenState])

  const markReviewed = useCallback(async () => {
    if (!currentItem || screenState.kind !== 'ready') {
      return
    }
    const now = Date.now()
    let nextReviewState = markMobileDiffReviewFileReviewed(
      screenState.reviewState,
      reviewDescriptorFromItem(currentItem),
      now
    )
    if (queue.every((item) => item.key === currentItem.key || item.isReviewed)) {
      nextReviewState = completeMobileDiffReviewState(nextReviewState, now)
    }
    await saveCommentsAndReviewState(screenState.comments, nextReviewState)
    const nextIndex = nextReviewIndexAfterMarkReviewed({
      currentIndex,
      currentItemKey: currentItem.key,
      filter,
      filteredQueue
    })
    if (nextIndex !== null) {
      setCurrentIndex(nextIndex)
    } else {
      // Why: the save can outlast a sheet the user opened meanwhile; never stack on or close it.
      openSheetWhenIdle({ kind: 'completion' })
    }
  }, [
    currentIndex,
    currentItem,
    filter,
    filteredQueue,
    openSheetWhenIdle,
    queue,
    saveCommentsAndReviewState,
    screenState,
    setCurrentIndex
  ])

  const markUnreviewed = useCallback(async () => {
    if (!currentItem || screenState.kind !== 'ready') {
      return
    }
    const now = Date.now()
    const nextReviewState = clearMobileDiffReviewFileReviewed(
      screenState.reviewState,
      currentItem.key,
      now
    )
    await saveCommentsAndReviewState(screenState.comments, {
      ...nextReviewState,
      completedAt: undefined
    })
  }, [currentItem, saveCommentsAndReviewState, screenState])

  return {
    closeComposer,
    deleteComment,
    markReviewed,
    markUnreviewed,
    openComposer,
    openEditComposer,
    saveCommentsAndReviewState,
    saveComposer
  }
}
