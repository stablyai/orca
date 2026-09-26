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
import { healMobileNativeChatStaleInput } from './mobile-native-chat-stale-input'
import type { ReviewScreenState, SendSheetState } from './mobile-diff-review-screen-model'

type SendActionsInput = {
  client: RpcClient | null
  connState: ConnectionState
  hostCapabilities: readonly string[]
  worktreeId: string
  screenState: ReviewScreenState
  setActionError: Dispatch<SetStateAction<string | null>>
  setSendSheet: Dispatch<SetStateAction<SendSheetState | null>>
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
    hostCapabilities,
    worktreeId,
    screenState,
    setActionError,
    setSendSheet,
    saveCommentsAndReviewState
  } = input

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

  // Read when a send settles, not when it was tapped: an agent launch can take a minute, and notes
  // written meanwhile must survive the whole-list save below, and its rollback if that save fails.
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
      setSendSheet(null)
    },
    [client, connState, markNotesSent, setActionError, setSendSheet]
  )

  const createTerminalAndSend = useCallback(
    async (comments: readonly DiffComment[]) => {
      // Reported, not thrown: the sheet's caller drops the promise, so a throw would show nothing.
      if (!client || connState !== 'connected') {
        setSendSheet(null)
        setActionError('Waiting for desktop...')
        return
      }
      if (agentLaunchInFlightRef.current) {
        return
      }
      agentLaunchInFlightRef.current = true
      // Closed up front so the wait (up to a minute for a terminal agent) shows its progress here.
      setSendSheet(null)
      setActionError('Starting an agent...')
      let result
      try {
        // The desktop asks which agent to use; the review screen has no picker, so this takes the
        // desktop's own default resolution with no saved recipe.
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
      // The warning is a note on a launch that went ahead, so it follows the success, not replaces it.
      setActionError(result.warning ? `Review notes sent. ${result.warning}` : 'Review notes sent')
    },
    [client, connState, hostCapabilities, markNotesSent, setActionError, setSendSheet, worktreeId]
  )

  const openSendSheet = useCallback(async () => {
    if (!client || connState !== 'connected') {
      setActionError('Waiting for desktop...')
      return
    }
    setSendSheet({ kind: 'loading' })
    try {
      const response = await reviewTerminalListRead.request(client, {
        worktree: `id:${worktreeId}`
      })
      let terminals
      terminals = interpretOrThrowRefusalMessage(
        () => reviewTerminalListRead.interpret(response),
        'Unable to load agent sessions'
      )
      setSendSheet({ kind: 'ready', terminals })
    } catch (err) {
      setSendSheet({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Unable to load agent sessions',
        terminals: []
      })
    }
  }, [client, connState, setActionError, setSendSheet, worktreeId])

  return {
    clearSentNotes,
    copyNotes,
    createTerminalAndSend,
    openSendSheet,
    sendPromptToTerminal
  }
}
