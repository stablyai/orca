import { useCallback, useRef, type Dispatch, type SetStateAction } from 'react'
import { translate } from '../i18n/mobile-i18n'
import type { DiffComment, MobileDiffReviewState } from '../../../src/shared/diff-comment-types'
import { triggerError, triggerSuccess } from '../platform/haptics'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import { sessionWorktreeNotesWrite } from './mobile-session-write-operations'
import {
  addMobileDiffComment,
  normalizeMobileDiffComments,
  removeMobileDiffComments
} from './mobile-diff-comments'
import { updateMobileDiffComment } from './mobile-diff-comment-edit'
import {
  clearMobileDiffReviewFileReviewed,
  completeMobileDiffReviewState,
  markMobileDiffReviewFileReviewed
} from './mobile-diff-review-state'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
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
  currentIndex: number
  composer: ComposerState | null
  composerBody: string
  setScreenState: Dispatch<SetStateAction<ReviewScreenState>>
  selectIndex: (index: number) => void
  /** The reader's navigation count; a save that outlasts a newer pick leaves that pick alone. */
  navigationRef: { readonly current: number }
  /** GitHub's viewed mark for a PR file, or null when the file's viewed state lives on the phone. */
  remoteViewed: (item: MobileDiffReviewQueueItem, viewed: boolean) => Promise<boolean> | null
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
    currentIndex,
    composer,
    composerBody,
    setScreenState,
    selectIndex,
    navigationRef,
    remoteViewed,
    setComposerBody,
    setActionError,
    sheets
  } = input
  const { openSheet, openSheetWhenIdle, closeSheet } = sheets

  const persistMetadata = useCallback(
    async (
      comments: readonly DiffComment[],
      base: readonly DiffComment[],
      reviewState: MobileDiffReviewState
    ) => {
      if (!client || connState !== 'connected') {
        throw new Error(
          translate(
            'session.useDiffReviewCommentActions.waitingForDesktop',
            'Waiting for desktop...'
          )
        )
      }
      const response = await sessionWorktreeNotesWrite.request(client, {
        worktree: `id:${worktreeId}`,
        diffComments: [...comments],
        diffCommentsBase: [...base],
        mobileDiffReview: reviewState
      })
      return interpretOrThrowRefusalMessage(
        () => sessionWorktreeNotesWrite.interpret(response),
        translate(
          'session.useDiffReviewCommentActions.saveStateFailed',
          'Failed to save review state'
        )
      )?.diffComments
    },
    [client, connState, worktreeId]
  )

  const updateReadyState = useCallback(
    (updater: (state: Extract<ReviewScreenState, { kind: 'ready' }>) => ReviewScreenState) => {
      setScreenState((prev) => (prev.kind === 'ready' ? updater(prev) : prev))
    },
    [setScreenState]
  )

  // Each save sends the whole notes and viewed state, so only the newest one may roll the screen back.
  const saveSeqRef = useRef(0)
  const saveCommentsAndReviewState = useCallback(
    async (comments: DiffComment[], reviewState: MobileDiffReviewState) => {
      const previous = screenState
      const seq = ++saveSeqRef.current
      updateReadyState((state) => ({ ...state, comments, reviewState }))
      try {
        const saved = await persistMetadata(
          comments,
          previous.kind === 'ready' ? previous.comments : comments,
          reviewState
        )
        if (saved !== undefined) {
          // Why: the host kept notes other devices changed; show its list unless a later save moved on.
          updateReadyState((state) =>
            state.comments === comments
              ? { ...state, comments: normalizeMobileDiffComments(saved, worktreeId) }
              : state
          )
        }
        triggerSuccess()
      } catch (err) {
        // A newer save already carries this one's change; rolling back would erase that newer state.
        if (previous.kind === 'ready' && seq === saveSeqRef.current) {
          setScreenState(previous)
        }
        triggerError()
        setActionError(
          err instanceof Error
            ? err.message
            : translate('session.useDiffReviewCommentActions.saveFailed', 'Failed to save review')
        )
        throw err
      }
    },
    [persistMetadata, screenState, setActionError, setScreenState, updateReadyState, worktreeId]
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
    if (
      !composer ||
      !currentItem ||
      screenState.kind !== 'ready' ||
      currentItem.scope === 'commit'
    ) {
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

  // Resolves whether the file is now viewed: on GitHub for a PR file, otherwise in the phone's review state.
  const setItemViewed = useCallback(
    async (item: MobileDiffReviewQueueItem, viewed: boolean): Promise<boolean> => {
      const remote = remoteViewed(item, viewed)
      if (remote) {
        return remote
      }
      const descriptor = reviewDescriptorFromItem(item)
      if (!descriptor || screenState.kind !== 'ready') {
        return false
      }
      const now = Date.now()
      let nextReviewState = viewed
        ? markMobileDiffReviewFileReviewed(screenState.reviewState, descriptor, now)
        : {
            ...clearMobileDiffReviewFileReviewed(screenState.reviewState, item.key, now),
            completedAt: undefined
          }
      if (
        viewed &&
        queue.every((candidate) => candidate.key === item.key || candidate.isReviewed)
      ) {
        nextReviewState = completeMobileDiffReviewState(nextReviewState, now)
      }
      try {
        await saveCommentsAndReviewState(screenState.comments, nextReviewState)
        return true
      } catch {
        // The failed save already rolled back and showed its error.
        return false
      }
    },
    [queue, remoteViewed, saveCommentsAndReviewState, screenState]
  )

  const markReviewed = useCallback(async () => {
    if (!currentItem) {
      return
    }
    const navigation = navigationRef.current
    if (!(await setItemViewed(currentItem, true)) || navigation !== navigationRef.current) {
      return
    }
    const nextIndex = nextReviewIndexAfterMarkReviewed({
      currentIndex,
      currentItemKey: currentItem.key,
      filteredQueue
    })
    if (nextIndex !== null) {
      selectIndex(nextIndex)
    } else {
      // Why: the save can outlast a sheet the user opened meanwhile; never stack on or close it.
      openSheetWhenIdle({ kind: 'completion' })
    }
  }, [
    currentIndex,
    currentItem,
    filteredQueue,
    navigationRef,
    openSheetWhenIdle,
    selectIndex,
    setItemViewed
  ])

  const toggleItemViewed = useCallback(
    async (item: MobileDiffReviewQueueItem) => {
      await setItemViewed(item, !item.isReviewed)
    },
    [setItemViewed]
  )

  return {
    closeComposer,
    deleteComment,
    markReviewed,
    openComposer,
    openEditComposer,
    saveCommentsAndReviewState,
    saveComposer,
    toggleItemViewed
  }
}
