import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import { translate } from '../i18n/mobile-i18n'
import type { DiffComment, MobileDiffReviewState } from '../../../src/shared/diff-comment-types'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { useClipboardWriter } from '../platform/clipboard'
import { triggerSuccess } from '../platform/haptics'
import { formatDiffComments } from '../../../src/shared/diff-comments-format'
import { clearSentMobileDiffComments, markMobileDiffCommentsSent } from './mobile-diff-comment-edit'
import { reviewTerminalListRead, reviewTerminalSendRun } from './mobile-review-terminal-operations'
import type { MobileReviewTerminalTab } from './review-terminal-reply-schema'
import { launchAgentWithPrompt } from './pr-ai-triage-launch'
import { interpretOrThrowRefusalMessage } from '../transport/rpc-refusal-message'
import { healMobileNativeChatStaleInput } from './native-chat/mobile-native-chat-stale-input'
import type { ReviewScreenState } from './mobile-diff-review-screen-model'
import type { ReviewSheetIntents } from './mobile-diff-review-sheets'

const NO_NOTES: readonly DiffComment[] = []

type SendActionsInput = {
  client: RpcClient | null
  connState: ConnectionState
  hostCapabilities: readonly string[]
  worktreeId: string
  screenState: ReviewScreenState
  setActionError: Dispatch<SetStateAction<string | null>>
  sheets: Pick<
    ReviewSheetIntents,
    'openSheet' | 'openSheetWhenIdle' | 'closeSheet' | 'updateSendSheet'
  >
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
  const { openSheet, openSheetWhenIdle, closeSheet, updateSendSheet } = sheets

  // Copies these notes, or every note when none are named.
  const copyNotes = useCallback(
    async (only?: readonly DiffComment[]) => {
      const comments = only ?? (screenState.kind === 'ready' ? screenState.comments : NO_NOTES)
      if (comments.length === 0) {
        return
      }
      // Contain clipboard refusal because copyNotes is fire-and-forget; never leave copied as the last feedback.
      try {
        await clipboard.writeText(formatDiffComments(comments))
      } catch (err) {
        setActionError(
          err instanceof Error
            ? err.message
            : translate(
                'session.useDiffReviewSendActions.copyFailed',
                'Unable to copy the review notes'
              )
        )
        return
      }
      triggerSuccess()
      setActionError(
        translate('session.useDiffReviewSendActions.notesCopied', 'Review notes copied')
      )
    },
    [clipboard, screenState, setActionError]
  )

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

  // From the picker, a send closes it; a direct send has no picker and must not close one opened meanwhile.
  const sendPromptToTerminal = useCallback(
    async (terminal: string, comments: readonly DiffComment[], fromPicker = true) => {
      if (!client || connState !== 'connected') {
        throw new Error(
          translate('session.useDiffReviewSendActions.waitingForDesktop', 'Waiting for desktop...')
        )
      }
      // Heal by terminal handle so native-chat image leftovers cannot join review notes.
      if (!(await healMobileNativeChatStaleInput({ client, terminal, deviceToken: null }))) {
        throw new Error(
          translate('session.useDiffReviewSendActions.sendFailed', 'Failed to send notes')
        )
      }
      const response = await reviewTerminalSendRun.request(client, {
        terminal,
        text: formatDiffComments(comments),
        enter: true
      })
      let accepted
      accepted = interpretOrThrowRefusalMessage(
        () => reviewTerminalSendRun.interpret(response),
        translate('session.useDiffReviewSendActions.sendFailed', 'Failed to send notes')
      )
      if (!accepted) {
        throw new Error(
          translate('session.useDiffReviewSendActions.inputLocked', 'Terminal input is locked')
        )
      }
      await markNotesSent(comments)
      triggerSuccess()
      setActionError(translate('session.useDiffReviewSendActions.notesSent', 'Review notes sent'))
      if (fromPicker) {
        closeSheet('send')
      }
    },
    [client, connState, closeSheet, markNotesSent, setActionError]
  )

  const createTerminalAndSend = useCallback(
    async (comments: readonly DiffComment[]) => {
      // Report instead of throwing because the sheet drops the promise.
      if (!client || connState !== 'connected') {
        closeSheet('send')
        setActionError(
          translate('session.useDiffReviewSendActions.waitingForDesktop', 'Waiting for desktop...')
        )
        return
      }
      if (agentLaunchInFlightRef.current) {
        return
      }
      agentLaunchInFlightRef.current = true
      // Close the sheet before a long launch so progress stays visible.
      closeSheet('send')
      setActionError(
        translate('session.useDiffReviewSendActions.startingAgent', 'Starting an agent...')
      )
      let result
      try {
        // Without an agent picker, use desktop’s default resolution with no saved recipe.
        result = await launchAgentWithPrompt({
          client,
          hostCapabilities,
          worktreeId,
          prompt: formatDiffComments(comments),
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
          translate(
            'session.useDiffReviewSendActions.promptNotSent',
            "The agent started, but the notes weren't sent. Use Copy Notes to paste them."
          )
        )
        return
      }
      await markNotesSent(comments)
      triggerSuccess()
      // Warnings describe successful launches, so append them to success feedback.
      setActionError(
        result.warning
          ? translate(
              'session.useDiffReviewSendActions.notesSentWithWarning',
              'Review notes sent. {{warning}}',
              {
                warning: result.warning
              }
            )
          : translate('session.useDiffReviewSendActions.notesSent', 'Review notes sent')
      )
    },
    [client, closeSheet, connState, hostCapabilities, markNotesSent, setActionError, worktreeId]
  )

  const openSendSheet = useCallback(async () => {
    if (!client || connState !== 'connected') {
      setActionError(
        translate('session.useDiffReviewSendActions.waitingForDesktop', 'Waiting for desktop...')
      )
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
        translate(
          'session.useDiffReviewSendActions.loadSessionsFailed',
          'Unable to load agent sessions'
        )
      )
      updateSendSheet({ kind: 'ready', terminals })
    } catch (err) {
      updateSendSheet({
        kind: 'error',
        message:
          err instanceof Error
            ? err.message
            : translate(
                'session.useDiffReviewSendActions.loadSessionsFailed',
                'Unable to load agent sessions'
              ),
        terminals: []
      })
    }
  }, [client, connState, openSheet, setActionError, updateSendSheet, worktreeId])

  const loadTerminals = useCallback(async () => {
    if (!client || connState !== 'connected') {
      throw new Error(
        translate('session.useDiffReviewSendActions.waitingForDesktop', 'Waiting for desktop...')
      )
    }
    const response = await reviewTerminalListRead.request(client, {
      worktree: `id:${worktreeId}`
    })
    return interpretOrThrowRefusalMessage(
      () => reviewTerminalListRead.interpret(response),
      translate(
        'session.useDiffReviewSendActions.loadSessionsFailed',
        'Unable to load agent sessions'
      )
    )
  }, [client, connState, worktreeId])

  // A note written in the diff goes straight to the workspace's one agent; with none or several, the picker asks.
  const sendNoteNow = useCallback(
    async (comment: DiffComment, listed?: readonly MobileReviewTerminalTab[]) => {
      let terminals
      try {
        terminals = listed ?? (await loadTerminals())
      } catch (err) {
        setActionError(
          err instanceof Error
            ? err.message
            : translate(
                'session.useDiffReviewSendActions.loadSessionsFailed',
                'Unable to load agent sessions'
              )
        )
        return
      }
      const agents = terminals.filter((terminal) => terminal.agent !== undefined)
      const [onlyAgent] = agents
      if (agents.length === 1 && onlyAgent) {
        try {
          await sendPromptToTerminal(onlyAgent.terminal, [comment], false)
        } catch (err) {
          setActionError(
            err instanceof Error
              ? err.message
              : translate('session.useDiffReviewSendActions.sendFailed', 'Failed to send notes')
          )
        }
        return
      }
      // The terminal list can outlast a sheet the user opened meanwhile; wait for it rather than replace it.
      openSheetWhenIdle({
        kind: 'send',
        load: { kind: 'ready', terminals: [...terminals] },
        only: [comment.id]
      })
    },
    [loadTerminals, openSheetWhenIdle, sendPromptToTerminal, setActionError]
  )

  return {
    clearSentNotes,
    copyNotes,
    createTerminalAndSend,
    loadTerminals,
    openSendSheet,
    sendNoteNow,
    sendPromptToTerminal
  }
}
