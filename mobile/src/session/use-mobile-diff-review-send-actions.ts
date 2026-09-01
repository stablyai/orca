import { useCallback, type Dispatch, type SetStateAction } from 'react'
import * as Clipboard from 'expo-clipboard'
import type { DiffComment, MobileDiffReviewState } from '../../../src/shared/diff-comment-types'
import type { ConnectionState } from '../transport/types'
import type { RpcClient } from '../transport/rpc-client'
import { triggerSuccess } from '../platform/haptics'
import { formatDiffComments, formatMobileDiffReviewPrompt } from './mobile-diff-comments'
import { clearSentMobileDiffComments, markMobileDiffCommentsSent } from './mobile-diff-comment-edit'
import {
  readMobileReviewCreatedTerminal,
  readMobileReviewTerminalSendAccepted,
  readMobileReviewTerminalTabs
} from './mobile-diff-review-rpc'
import { healMobileNativeChatStaleInput } from './mobile-native-chat-stale-input'
import { resolveIdentityCreateTerminalParams } from './identity-create-terminal-params'
import { readMobileVaultResumeCreateOutcome } from './ai-vault-resume-outcome'
import type { ReviewScreenState, SendSheetState } from './mobile-diff-review-screen-model'

type SendActionsInput = {
  client: RpcClient | null
  connState: ConnectionState
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
  const {
    client,
    connState,
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
    await Clipboard.setStringAsync(formatDiffComments(screenState.comments))
    triggerSuccess()
    setActionError('Review notes copied')
  }, [screenState, setActionError])

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
      const response = await client.sendRequest('terminal.send', {
        terminal,
        text: formatMobileDiffReviewPrompt(comments),
        enter: true
      })
      if (!response.ok) {
        throw new Error(response.error?.message || 'Failed to send notes')
      }
      if (!readMobileReviewTerminalSendAccepted(response.result)) {
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
      if (!client || connState !== 'connected') {
        throw new Error('Waiting for desktop...')
      }
      const createParams = await resolveIdentityCreateTerminalParams(client, worktreeId)
      const response = await client.sendRequest('session.tabs.createTerminal', {
        ...createParams,
        activate: false,
        select: true,
        navigation: 'caller'
      })
      if (!response.ok) {
        throw new Error(response.error?.message || 'Failed to create terminal')
      }
      const created = readMobileReviewCreatedTerminal(response.result)
      if (!created) {
        // Why: a success response missing `tab` is the typed pre-spawn agentLaunch
        // failure arm (tombstoned/disabled agent, capacity, ...), not a malformed
        // response — read the failure code like the vault-resume family instead of
        // reporting a generic "invalid response".
        const outcome = readMobileVaultResumeCreateOutcome(response.result)
        throw new Error(
          outcome.kind === 'failed'
            ? `Couldn't start the agent (${outcome.code}).`
            : 'Created terminal response was invalid'
        )
      }
      await sendPromptToTerminal(created.terminal, comments)
    },
    [client, connState, sendPromptToTerminal, worktreeId]
  )

  const openSendSheet = useCallback(async () => {
    if (!client || connState !== 'connected') {
      setActionError('Waiting for desktop...')
      return
    }
    setSendSheet({ kind: 'loading' })
    try {
      const response = await client.sendRequest('session.tabs.list', {
        worktree: `id:${worktreeId}`
      })
      if (!response.ok) {
        throw new Error(response.error?.message || 'Unable to load agent sessions')
      }
      setSendSheet({ kind: 'ready', terminals: readMobileReviewTerminalTabs(response.result) })
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
