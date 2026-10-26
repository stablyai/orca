import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { DiffComment, MobileDiffReviewState } from '../../../src/shared/diff-comment-types'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerSuccess } from '../platform/haptics'
import { formatDiffComments, formatMobileDiffReviewPrompt } from './mobile-diff-comments'
import { clearSentMobileDiffComments, markMobileDiffCommentsSent } from './mobile-diff-comment-edit'
import { reviewTerminalListRead, reviewTerminalSendRun } from './mobile-review-terminal-operations'
import { launchAgentWithPrompt } from './pr-ai-triage-launch'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import { healMobileNativeChatStaleInput } from './native-chat/mobile-native-chat-stale-input'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import type { ReviewSheetIntents } from './mobile-diff-review-sheets'

type SendActionsInput = {
  client: RpcClient | null
  connState: ConnectionState
  hostCapabilities: readonly string[]
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
  // Use the clipboard seam: iOS custom-scheme pages lack the secure context their own clipboard needs.
  const clipboard = useClipboardWriter()
  const {
    client,
    connState,
    hostCapabilities,
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
    // Contain clipboard refusal because copyNotes is fire-and-forget; never leave copied as the last feedback.
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

  // Read notes at settlement: long launches must preserve newer notes through whole-list saves and rollback.
  const latestRef = useRef({ screenState, save: saveCommentsAndReviewState })
  useEffect(() => {
    latestRef.current = { screenState, save: saveCommentsAndReviewState }
  }, [saveCommentsAndReviewState, screenState])
  // One launch at a time: each tap is a new operation, so a second tap would start a second agent.
  const agentLaunchInFlightRef = useRef(false)

  const markNotesSent = useCallback(async (comments: readonly DiffComment[]) => {
    const { screenState: current, save } = latestRef.current
    if (current.kind !== 'ready') {
      return
    }
    const next = markMobileDiffCommentsSent(
      current.comments,
      new Set(comments.map((comment) => comment.id)),
      Date.now()
    )
    await save(next, current.reviewState)
  }, [])

  const sendPromptToTerminal = useCallback(
    async (terminal: string, comments: readonly DiffComment[]) => {
      if (!client || connState !== 'connected') {
        throw new Error('Waiting for desktop...')
      }
      // Heal by terminal handle so native-chat image leftovers cannot join review notes.
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
      // Report instead of throwing because the sheet drops the promise.
      if (!client || connState !== 'connected') {
        closeSheet('send')
        setActionError('Waiting for desktop...')
        return
      }
      if (agentLaunchInFlightRef.current) {
        return
      }
      agentLaunchInFlightRef.current = true
      // Close the sheet before a long launch so progress stays visible.
      closeSheet('send')
      setActionError('Starting an agent...')
      let result
      try {
        // Without an agent picker, use desktop’s default resolution with no saved recipe.
        result = await launchAgentWithPrompt({
          client,
          hostCapabilities,
          worktreeId,
          prompt: formatMobileDiffReviewPrompt(comments),
          actionId: null,
          launchSource: 'notes_send'
        })
      } finally {
        agentLaunchInFlightRef.current = false
      }
      if (result.kind === 'not-started' || result.kind === 'unconfirmed') {
        setActionError(result.message)
        return
      }
      if (result.kind === 'prompt-not-sent') {
        // Notes stay unsent so Copy Notes and a later send still carry them.
        setActionError(
          "The agent started, but the notes weren't sent. Use Copy Notes to paste them."
        )
        return
      }
      await markNotesSent(comments)
      triggerSuccess()
      // Warnings describe successful launches, so append them to success feedback.
      setActionError(result.warning ? `Review notes sent. ${result.warning}` : 'Review notes sent')
    },
    [client, closeSheet, connState, hostCapabilities, markNotesSent, setActionError, worktreeId]
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
