import type { Dispatch, RefObject, SetStateAction } from 'react'
import type { FlatList } from 'react-native'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { triggerSelection } from '../platform/haptics'
import { findNextMobileDiffHunkIndex, findPreviousMobileDiffHunkIndex } from './mobile-diff-hunks'
import type {
  MobileDiffReviewQueueFilter,
  MobileDiffReviewQueueItem
} from './mobile-diff-review-queue'
import type {
  ComposerState,
  ReviewDiffLine,
  ReviewDiffState,
  ReviewScreenState,
  SendSheetState
} from './mobile-diff-review-screen-model'
import { useMobileDiffReviewCommentActions } from './use-mobile-diff-review-comment-actions'
import { useMobileDiffReviewGitActions } from './use-mobile-diff-review-git-actions'
import { useMobileDiffReviewSendActions } from './use-mobile-diff-review-send-actions'

type InteractionInput = {
  client: RpcClient | null
  connState: ConnectionState
  hostId: string
  worktreeId: string
  screenState: ReviewScreenState
  diffState: ReviewDiffState
  currentItem: MobileDiffReviewQueueItem | null
  queue: MobileDiffReviewQueueItem[]
  filteredQueue: MobileDiffReviewQueueItem[]
  filter: MobileDiffReviewQueueFilter
  currentIndex: number
  activeHunkIndex: number | null
  composer: ComposerState | null
  composerBody: string
  listRef: RefObject<FlatList<ReviewDiffLine> | null>
  setScreenState: Dispatch<SetStateAction<ReviewScreenState>>
  setFilter: Dispatch<SetStateAction<MobileDiffReviewQueueFilter>>
  setCurrentIndex: Dispatch<SetStateAction<number>>
  setActiveHunkIndex: Dispatch<SetStateAction<number | null>>
  setComposer: Dispatch<SetStateAction<ComposerState | null>>
  setComposerBody: Dispatch<SetStateAction<string>>
  setActionError: Dispatch<SetStateAction<string | null>>
  setBusyAction: Dispatch<SetStateAction<string | null>>
  setSendSheet: Dispatch<SetStateAction<SendSheetState | null>>
  setShowCompletion: Dispatch<SetStateAction<boolean>>
  loadReviewData: () => Promise<void>
  onOpenSession: () => void
  onReconnect: (hostId: string) => void | Promise<void>
}

export function useMobileDiffReviewInteractions(input: InteractionInput) {
  const {
    client,
    connState,
    hostId,
    worktreeId,
    screenState,
    diffState,
    currentItem,
    queue,
    filteredQueue,
    filter,
    currentIndex,
    activeHunkIndex,
    composer,
    composerBody,
    listRef,
    setScreenState,
    setFilter,
    setCurrentIndex,
    setActiveHunkIndex,
    setComposer,
    setComposerBody,
    setActionError,
    setBusyAction,
    setSendSheet,
    setShowCompletion,
    loadReviewData,
    onOpenSession,
    onReconnect
  } = input

  const {
    closeComposer,
    deleteComment,
    markReviewed,
    markUnreviewed,
    openComposer,
    openEditComposer,
    saveCommentsAndReviewState,
    saveComposer
  } = useMobileDiffReviewCommentActions({
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
  })

  const { runGitMutation, stageReviewedFiles } = useMobileDiffReviewGitActions({
    client,
    connState,
    worktreeId,
    queue,
    setActionError,
    setBusyAction,
    loadReviewData
  })

  const { clearSentNotes, copyNotes, createTerminalAndSend, openSendSheet, sendPromptToTerminal } =
    useMobileDiffReviewSendActions({
      client,
      connState,
      worktreeId,
      screenState,
      setActionError,
      setSendSheet,
      saveCommentsAndReviewState
    })

  return {
    clearSentNotes,
    closeComposer,
    copyNotes,
    createTerminalAndSend,
    deleteComment,
    jumpHunk: (direction: 'next' | 'previous') => {
      if (diffState.kind !== 'ready') {
        return
      }
      const currentLineIndex =
        activeHunkIndex === null ? -1 : (diffState.hunks[activeHunkIndex]?.startIndex ?? -1)
      const nextIndex =
        direction === 'next'
          ? findNextMobileDiffHunkIndex(diffState.hunks, currentLineIndex)
          : findPreviousMobileDiffHunkIndex(diffState.hunks, currentLineIndex)
      const target = nextIndex === null ? null : diffState.hunks[nextIndex]
      if (!target || nextIndex === null) {
        return
      }
      setActiveHunkIndex(nextIndex)
      listRef.current?.scrollToIndex({
        index: target.startIndex,
        animated: true,
        viewPosition: 0.16
      })
      triggerSelection()
    },
    markReviewed,
    markUnreviewed,
    moveFile: (direction: 'next' | 'previous') => {
      if (filteredQueue.length === 0) {
        return
      }
      setCurrentIndex((index) =>
        direction === 'next'
          ? index + 1 >= filteredQueue.length
            ? 0
            : index + 1
          : index - 1 < 0
            ? filteredQueue.length - 1
            : index - 1
      )
    },
    openComposer,
    openEditComposer,
    openInSession: async () => {
      if (!client || !currentItem || currentItem.scope === 'branch') {
        return
      }
      const response = await client.sendRequest('files.openDiff', {
        worktree: `id:${worktreeId}`,
        relativePath: currentItem.filePath,
        staged: currentItem.scope === 'staged'
      })
      if (!response.ok) {
        setActionError(response.error?.message || 'Unable to open in session')
        return
      }
      onOpenSession()
    },
    openSendSheet,
    retryAction: () => {
      if (connState !== 'connected' && hostId) {
        void onReconnect(hostId)
        return
      }
      void loadReviewData()
    },
    runGitMutation,
    saveComposer,
    selectFilter: (nextFilter: MobileDiffReviewQueueFilter) => {
      setFilter(nextFilter)
      setCurrentIndex(0)
    },
    sendPromptToTerminal,
    stageReviewedFiles
  }
}
