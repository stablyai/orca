import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { DiffComment, MobileDiffReviewState } from '../../../src/shared/diff-comment-types'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerSuccess } from '../platform/haptics'
import { formatDiffComments, formatMobileDiffReviewPrompt } from './mobile-diff-comments'
import { clearSentMobileDiffComments, markMobileDiffCommentsSent } from './mobile-diff-comment-edit'
import {
  reviewTerminalCreateRun,
  reviewTerminalListRead,
  reviewTerminalSendRun
} from './mobile-review-terminal-operations'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import { healMobileNativeChatStaleInput } from './mobile-native-chat-stale-input'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import type { ReviewSheetIntents } from './mobile-diff-review-sheets'

type SendActionsInput = {
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  screenState: ReviewScreenState
  setActionError: Dispatch<SetStateAction<string | null>>
  sheets: Pick<ReviewSheetIntents, 'openSheet' | 'closeSheet' | 'updateSendSheet'>
  saveCommentsAndReviewState: (
    comments: DiffComment[],
    reviewState: MobileDiffReviewState
  ) => Promise<void>
}

export function useMobileDiffReviewSendActions(input: SendActionsInput) {
  // The seam, not `expo-clipboard`: inside the shell the page's own clipboard needs a secure
  // context, which the iOS custom scheme is not and Android's https is.
  const clipboard = useClipboardWriter()
  const {
    client,
    connState,
    worktreeId,
    screenState,
    setActionError,
    sheets,
    saveCommentsAndReviewState
  } = input
  const { openSheet, closeSheet, updateSendSheet } = sheets

  const copyNotes = useCallback(async () => {
    if (screenState.kind !== 'ready' || screenState.comments.length === 0) {
      return
    }
    // Caught here because the only caller is `void controller.copyNotes()`: the seam rejects when
    // the pasteboard refused, and an uncaught rejection would leave "copied" as the last word.
    try {
      await clipboard.writeText(formatDiffComments(screenState.comments))
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Unable to copy the review notes')
      return
    }
    triggerSuccess()
    setActionError('Review notes copied')
  }, [clipboard, screenState, setActionError])

  const clearSentNotes = useCallback(async () => {
    if (screenState.kind !== 'ready') {
      return
    }
    const nextComments = clearSentMobileDiffComments(screenState.comments)
    await saveCommentsAndReviewState(nextComments, screenState.reviewState)
  }, [saveCommentsAndReviewState, screenState])

  const markNotesSent = useCallback(
    async (comments: readonly DiffComment[]) => {
      if (screenState.kind !== 'ready') {
        return
      }
      const next = markMobileDiffCommentsSent(
        screenState.comments,
        new Set(comments.map((comment) => comment.id)),
        Date.now()
      )
      await saveCommentsAndReviewState(next, screenState.reviewState)
    },
    [saveCommentsAndReviewState, screenState]
  )

  const sendPromptToTerminal = useCallback(
    async (terminal: string, comments: readonly DiffComment[]) => {
      if (!client || connState !== 'connected') {
        throw new Error('Waiting for desktop...')
      }
      // Marked by terminal handle, not by surface, so a paste orphaned here by native
      // chat would ride along with these notes (#10228). Diff review carries no device token.
      if (!(await healMobileNativeChatStaleInput({ client, terminal, deviceToken: null }))) {
        throw new Error('Failed to send notes')
      }
      const response = await reviewTerminalSendRun.request(client, {
        terminal,
        text: formatMobileDiffReviewPrompt(comments),
        enter: true
      })
      let accepted
      accepted = interpretOrThrowRefusalMessage(
        () => reviewTerminalSendRun.interpret(response),
        'Failed to send notes'
      )
      if (!accepted) {
        throw new Error('Terminal input is locked')
      }
      await markNotesSent(comments)
      triggerSuccess()
      setActionError('Review notes sent')
      closeSheet('send')
    },
    [client, connState, closeSheet, markNotesSent, setActionError]
  )

  const createTerminalAndSend = useCallback(
    async (comments: readonly DiffComment[]) => {
      if (!client || connState !== 'connected') {
        throw new Error('Waiting for desktop...')
      }
      const response = await reviewTerminalCreateRun.request(client, {
        worktree: `id:${worktreeId}`,
        activate: false,
        select: true,
        navigation: 'caller'
      })
      let created
      created = interpretOrThrowRefusalMessage(
        () => reviewTerminalCreateRun.interpret(response),
        'Failed to create terminal'
      )
      await sendPromptToTerminal(created.terminal, comments)
    },
    [client, connState, sendPromptToTerminal, worktreeId]
  )

  const openSendSheet = useCallback(async () => {
    if (!client || connState !== 'connected') {
      setActionError('Waiting for desktop...')
      return
    }
    openSheet({ kind: 'send', load: { kind: 'loading' } })
    try {
      const response = await reviewTerminalListRead.request(client, {
        worktree: `id:${worktreeId}`
      })
      let terminals
      terminals = interpretOrThrowRefusalMessage(
        () => reviewTerminalListRead.interpret(response),
        'Unable to load agent sessions'
      )
      updateSendSheet({ kind: 'ready', terminals })
    } catch (err) {
      updateSendSheet({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Unable to load agent sessions',
        terminals: []
      })
    }
  }, [client, connState, openSheet, setActionError, updateSendSheet, worktreeId])

  return {
    clearSentNotes,
    copyNotes,
    createTerminalAndSend,
    openSendSheet,
    sendPromptToTerminal
  }
}
