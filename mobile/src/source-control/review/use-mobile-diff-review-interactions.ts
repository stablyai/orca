import { useRef, type Dispatch, type SetStateAction } from 'react'
import { translate } from '../../i18n/mobile-i18n'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { MobileDiffReviewQueueItem } from './mobile-diff-review-queue'
import type { ComposerState, ReviewScreenState } from './mobile-diff-review-screen-model'
import type { ReviewSheet, ReviewSheetIntents } from './mobile-diff-review-sheets'
import type { MobileReviewTerminalTab } from './review-terminal-reply-schema'
import type { MobileDiffReviewNoteDraft } from './use-mobile-diff-review-note-draft'
import { sourceFileDiffOpenRun } from '../../files/session-documents/mobile-source-file-open-operations'
import { refusedRpcMessageOrFallback } from '../../transport/rpc/rpc-refusal-message'
import { useMobileDiffReviewCommentActions } from './use-mobile-diff-review-comment-actions'
import { useMobileDiffReviewGitActions } from './use-mobile-diff-review-git-actions'
import { useMobileDiffReviewSendActions } from './use-mobile-diff-review-send-actions'
import { useMobileDiffReviewRangeNote } from './use-mobile-diff-review-range-note'
import { connectionRetryAction } from '../../transport/connection/connection-retry-action'

type InteractionInput = {
  client: RpcClient | null
  connState: ConnectionState
  hostCapabilities: readonly string[]
  hostId: string
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
  /** Keeps a file open by key, through the reload that follows a mutation. */
  selectKey: (key: string) => void
  moveSelection: (direction: 'next' | 'previous') => void
  remoteViewed: (item: MobileDiffReviewQueueItem, viewed: boolean) => Promise<boolean> | null
  noteDraft: MobileDiffReviewNoteDraft
  setActionError: Dispatch<SetStateAction<string | null>>
  setBusyAction: Dispatch<SetStateAction<string | null>>
  sheets: ReviewSheetIntents
  loadReviewData: () => Promise<void>
  onOpenSession: () => void
  onReconnect: ((hostId: string) => void | Promise<void>) | null
}

export function useMobileDiffReviewInteractions(input: InteractionInput) {
  const {
    client,
    connState,
    hostCapabilities,
    hostId,
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
    selectKey,
    moveSelection,
    remoteViewed,
    noteDraft,
    setActionError,
    setBusyAction,
    sheets,
    loadReviewData,
    onOpenSession,
    onReconnect
  } = input

  // Bumped by every file the reader picks, so a slow save or stage never overrides a newer pick.
  const navigationRef = useRef(0)

  const {
    clearSavedNote,
    closeComposer,
    deleteComment,
    markReviewed,
    openComposer,
    openEditComposer,
    openNewNoteSheet,
    saveCommentsAndReviewState,
    saveComposer,
    toggleItemViewed
  } = useMobileDiffReviewCommentActions({
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
    noteDraft,
    setActionError,
    sheets
  })

  const saveRangeNote = useMobileDiffReviewRangeNote({
    worktreeId,
    screenState,
    currentItem,
    composerBody,
    saveCommentsAndReviewState
  })

  const { runGitMutation } = useMobileDiffReviewGitActions({
    client,
    connState,
    worktreeId,
    setActionError,
    setBusyAction,
    loadReviewData
  })

  const {
    clearSentNotes,
    copyNotes,
    createTerminalAndSend,
    loadTerminals,
    openSendSheet,
    sendNoteNow,
    sendPromptToTerminal
  } = useMobileDiffReviewSendActions({
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
    clearSavedNote,
    clearSentNotes,
    closeComposer,
    copyNotes,
    createTerminalAndSend,
    deleteComment,
    markReviewed,
    selectItem: (item: MobileDiffReviewQueueItem) => {
      navigationRef.current += 1
      selectKey(item.key)
    },
    moveFile: (direction: 'next' | 'previous') => {
      navigationRef.current += 1
      moveSelection(direction)
    },
    openComposer,
    openEditComposer,
    openNewNoteSheet,
    openInSession: async () => {
      // Only working-tree files have a desktop diff tab.
      if (
        !client ||
        !currentItem ||
        (currentItem.scope !== 'unstaged' && currentItem.scope !== 'staged')
      ) {
        return
      }
      const response = await sourceFileDiffOpenRun.request(client, {
        worktree: `id:${worktreeId}`,
        relativePath: currentItem.filePath,
        staged: currentItem.scope === 'staged'
      })
      try {
        sourceFileDiffOpenRun.interpret(response)
      } catch (error) {
        setActionError(
          refusedRpcMessageOrFallback(
            error,
            translate('session.useDiffReviewInteractions.openFailed', 'Unable to open in session')
          )
        )
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
    sendPromptToTerminal,
    loadTerminals,
    // The sheet's own lines and the terminals it already listed; the draft clears once the note is saved.
    sendRange: async (
      sheet: Extract<ReviewSheet, { kind: 'range' }>,
      terminals?: readonly MobileReviewTerminalTab[]
    ) => {
      const saved = await saveRangeNote(sheet)
      if (!('comment' in saved)) {
        return saved.error
      }
      clearSavedNote(saved.comment.body)
      sheets.closeSheet('range', sheet)
      await sendNoteNow(saved.comment, terminals)
      return null
    },
    // Staging drops the file from the uncommitted queue; land on the file after it, wrapping from the last.
    stageAndOpenNext: async () => {
      if (!currentItem?.canStage) {
        return
      }
      const nextItem =
        filteredQueue.length > 1 ? filteredQueue[(currentIndex + 1) % filteredQueue.length] : null
      const navigation = navigationRef.current
      const staged = await runGitMutation('git.stage', currentItem)
      if (staged && nextItem && navigation === navigationRef.current) {
        selectKey(nextItem.key)
      }
    },
    toggleItemViewed
  }
}
