import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { DiffComment, MobileDiffReviewState } from '../../../src/shared/types'
import { triggerError, triggerSuccess } from '../platform/haptics'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
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
  setComposer: Dispatch<SetStateAction<ComposerState | null>>
  setComposerBody: Dispatch<SetStateAction<string>>
  setActionError: Dispatch<SetStateAction<string | null>>
  setShowCompletion: Dispatch<SetStateAction<boolean>>
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
    setComposer,
    setComposerBody,
    setActionError,
    setShowCompletion
  } = input

  const persistMetadata = useCallback(
    async (comments: readonly DiffComment[], reviewState: MobileDiffReviewState) => {
      if (!client || connState !== 'connected') {
        throw new Error('Waiting for desktop...')
      }
      const response = await client.sendRequest('worktree.set', {
        worktree: `id:${worktreeId}`,
        diffComments: comments,
        mobileDiffReview: reviewState
      })
      if (!response.ok) {
        throw new Error(response.error?.message || 'Failed to save review state')
      }
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
      setComposer({ mode: 'create', lineNumber })
      setComposerBody('')
    },
    [setComposer, setComposerBody]
  )

  const openEditComposer = useCallback(
    (comment: DiffComment) => {
      setComposer({ mode: 'edit', comment })
      setComposerBody(comment.body)
    },
    [setComposer, setComposerBody]
  )

  const closeComposer = useCallback(() => {
    setComposer(null)
    setComposerBody('')
  }, [setComposer, setComposerBody])

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
      setShowCompletion(true)
    }
  }, [
    currentIndex,
    currentItem,
    filter,
    filteredQueue,
    queue,
    saveCommentsAndReviewState,
    screenState,
    setCurrentIndex,
    setShowCompletion
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
