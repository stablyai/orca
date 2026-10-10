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
  ReviewScreenState
} from './mobile-diff-review-screen-model'
import type { ReviewSheetIntents } from './mobile-diff-review-sheets'
import { sourceFileDiffOpenRun } from '../source-control/mobile-source-file-open-operations'
import { refusedRpcMessageOrFallback } from '../transport/rpc-refusal-message'
import { isRendererUnavailableRefusal } from '../transport/renderer-unavailable-refusal'
import { useMobileDiffReviewCommentActions } from './use-mobile-diff-review-comment-actions'
import { useMobileDiffReviewGitActions } from './use-mobile-diff-review-git-actions'
import { useMobileDiffReviewSendActions } from './use-mobile-diff-review-send-actions'
import { connectionRetryAction } from '../transport/connection-retry-action'

type InteractionInput = {
  client: RpcClient | null
  connState: ConnectionState
  hostCapabilities: readonly string[]
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
  setComposerBody: Dispatch<SetStateAction<string>>
  setActionError: Dispatch<SetStateAction<string | null>>
  setBusyAction: Dispatch<SetStateAction<string | null>>
  sheets: ReviewSheetIntents
  loadReviewData: () => Promise<void>
  onOpenSession: () => void
  onReconnect: ((hostId: string) => void | Promise<void>) | null
}

export const SESSION_TABS_UNAVAILABLE_MESSAGE =
  'This host has no desktop to open tabs in. The diff is shown here instead.'

export function useMobileDiffReviewInteractions(input: InteractionInput) {
  const {
    client,
    connState,
    hostCapabilities,
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
    setComposerBody,
    setActionError,
    setBusyAction,
    sheets,
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
    setComposerBody,
    setActionError,
    sheets
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
      hostCapabilities,
      worktreeId,
      screenState,
      setActionError,
      sheets,
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
      const response = await sourceFileDiffOpenRun.request(client, {
        worktree: `id:${worktreeId}`,
        relativePath: currentItem.filePath,
        staged: currentItem.scope === 'staged'
      })
      // Why: a host with no renderer (orca serve, orcad) has no tab to open; this screen is the diff view.
      // Not latched: a serve host can gain a window, or the client be replaced, while this screen is open.
      if (isRendererUnavailableRefusal(response)) {
        setActionError(SESSION_TABS_UNAVAILABLE_MESSAGE)
        return
      }
      try {
        sourceFileDiffOpenRun.interpret(response)
      } catch (error) {
        setActionError(refusedRpcMessageOrFallback(error, 'Unable to open in session'))
        return
      }
      onOpenSession()
    },
    openSendSheet,
    retryAction: connectionRetryAction({
      hostId,
      needsReconnect: connState !== 'connected',
      forceReconnect: onReconnect,
      reload: () => void loadReviewData()
    }),
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
