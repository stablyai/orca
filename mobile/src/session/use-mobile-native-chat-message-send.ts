import { useCallback, type MutableRefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  clearMobileNativeChatInput,
  openMobileNativeChatSendBudget,
  sendMobileNativeChatMessageWithOutcome,
  typeMobileNativeChatCommandWithOutcome,
  type MobileNativeChatSendOutcome
} from './mobile-native-chat-send'
import type { CatalogCommandDelivery } from '../../../src/shared/agent-session-option-catalog'
import { isSlashCommandDraft } from '../../../src/shared/native-chat-slash-commands'
import { healMobileNativeChatStaleInput } from './mobile-native-chat-stale-input'
import { classifyMobileNativeChatSend } from './mobile-native-chat-send-classification'
import {
  acquireMobileNativeChatTerminalWrite,
  releaseMobileNativeChatTerminalWrite
} from './mobile-native-chat-terminal-write-lock'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'
import { UNCONFIRMED_SEND_MESSAGE } from './use-mobile-native-chat-unconfirmed-sends'
import type { MobileNativeChatLaunchDraftSeed } from './use-mobile-native-chat-launch-draft-seed'
import {
  AGENT_TUI_CLEAR_INPUT_LINE,
  buildAgentTuiClearInputForText
} from '../../../src/shared/agent-tui-input-clear'
import { buildNativeChatPasteBytes } from '../../../src/shared/native-chat-paste-bytes'

export type MobileNativeChatMessageSend = {
  send: (text: string, images?: string[]) => Promise<boolean>
  // Preserve unknown for callers healing pre-pasted input; spend their existing action deadline across paste and text.
  sendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number,
    // Only a structured send carries them; a terminal chat's images were pasted before this.
    _attachments?: readonly unknown[],
    sentAt?: number
  ) => Promise<MobileNativeChatSendOutcome>
  answerQuestion: (text: string) => Promise<boolean>
  dispatchCommand: (
    text: string,
    options?: { delivery?: CatalogCommandDelivery }
  ) => Promise<MobileNativeChatSendOutcome>
}

export function useMobileNativeChatMessageSend(args: {
  client: RpcClient | null
  enabled: boolean
  handleRef: MutableRefObject<string | null>
  deviceTokenRef: MutableRefObject<string | null>
  agentRef: MutableRefObject<string | null>
  // Capture control-send scope before await so later tab switches cannot record options on the wrong tab.
  commandSendRef: MutableRefObject<(command: string) => void>
  captureSendOrigin: (text: string, sentAt?: number) => MobileNativeChatSendOrigin | null
  readSeededLaunchDraftSeed: () => MobileNativeChatLaunchDraftSeed | null
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
  restoreRejectedDraft: (origin: MobileNativeChatSendOrigin, text: string) => void
  acceptSend: (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => void
  holdUnconfirmedSend: (
    origin: MobileNativeChatSendOrigin,
    text: string,
    onUnconfirmed: () => void
  ) => void
  onSendError: (message: string) => void
}): MobileNativeChatMessageSend {
  const {
    client,
    enabled,
    handleRef,
    deviceTokenRef,
    agentRef,
    commandSendRef,
    captureSendOrigin,
    readSeededLaunchDraftSeed,
    clearDraftForSend,
    restoreRejectedDraft,
    acceptSend,
    holdUnconfirmedSend,
    onSendError
  } = args

  const sendMessage = useCallback(
    async (
      draftText: string,
      images: string[] | undefined,
      syncComposer: boolean,
      recordControlSend: boolean,
      sharedDeadline?: number,
      requireWriteSettlement?: true,
      sentAt?: number
    ): Promise<MobileNativeChatSendOutcome> => {
      // Trim only outgoing bytes to prevent rapid-send concatenation; restore the exact typed draft on rejection.
      const text = draftText.trimEnd()
      const handle = handleRef.current
      const origin = captureSendOrigin(text, sentAt)
      const agent = agentRef.current
      const recordCommand = commandSendRef.current
      // Connection drops precede lease collapse by one render; gate immediately to avoid waiting the whole send budget.
      if (!client || !handle || !origin || !enabled) {
        onSendError('Message not sent (disconnected)')
        return 'rejected'
      }
      // Heal orphaned input before clearing draft; failed heals preserve typing, and heal/text spend the same action deadline.
      const deadline = sharedDeadline ?? openMobileNativeChatSendBudget()
      const healArgs = {
        client,
        terminal: handle,
        deviceToken: deviceTokenRef.current,
        deadline
      }
      if (!(await healMobileNativeChatStaleInput(healArgs))) {
        onSendError('Message not sent')
        return 'rejected'
      }
      // Clear optimistically before slow/lost acknowledgements; only definite rejection restores the draft.
      if (syncComposer) {
        clearDraftForSend(origin, draftText)
      }
      const seededLaunchDraft = readSeededLaunchDraftSeed()
      const classification = classifyMobileNativeChatSend(agent, text)
      const typesCodexCommand =
        agent === 'codex' &&
        classification !== 'chat' &&
        isSlashCommandDraft(text) &&
        !images?.length
      if (!images?.length && (seededLaunchDraft || !typesCodexCommand)) {
        const cleared = await clearMobileNativeChatInput({
          client,
          terminal: handle,
          clearInput: seededLaunchDraft
            ? buildAgentTuiClearInputForText(seededLaunchDraft.text)
            : AGENT_TUI_CLEAR_INPUT_LINE,
          deadline,
          ...(deviceTokenRef.current
            ? { mobileClient: { id: deviceTokenRef.current, type: 'mobile' } }
            : {})
        })
        if (!cleared) {
          if (syncComposer) {
            restoreRejectedDraft(origin, draftText)
          }
          onSendError('Message not sent')
          return 'rejected'
        }
      }
      const mobileClient = deviceTokenRef.current
        ? { id: deviceTokenRef.current, type: 'mobile' as const }
        : undefined
      const resolvedLaunchDraft =
        syncComposer && typeof seededLaunchDraft?.createdAt === 'number'
          ? { text: seededLaunchDraft.text, createdAt: seededLaunchDraft.createdAt }
          : undefined
      const outcome = typesCodexCommand
        ? await typeMobileNativeChatCommandWithOutcome({
            client,
            terminal: handle,
            command: text,
            ...(requireWriteSettlement ? { requireWriteSettlement } : {}),
            ...(resolvedLaunchDraft ? { resolvedLaunchDraft } : {}),
            ...(mobileClient ? { mobileClient } : {}),
            deadline
          })
        : await sendMobileNativeChatMessageWithOutcome({
            client,
            terminal: handle,
            text: buildNativeChatPasteBytes(text),
            ...(requireWriteSettlement ? { requireWriteSettlement } : {}),
            ...(resolvedLaunchDraft ? { resolvedLaunchDraft } : {}),
            deadline,
            ...(mobileClient ? { mobileClient } : {})
          })
      // TUI commands cannot reconcile user echoes, so neither optimistic bubbles nor unconfirmed transcript holds apply.
      if (outcome === 'unknown') {
        if (classification === 'chat') {
          // Lost acknowledgement proves no failure; verify delivery by transcript rather than reporting not sent.
          holdUnconfirmedSend(origin, text, () => onSendError(UNCONFIRMED_SEND_MESSAGE))
        }
        return 'unknown'
      }
      if (outcome === 'rejected') {
        if (syncComposer) {
          restoreRejectedDraft(origin, draftText)
        }
        onSendError('Message not sent')
        return 'rejected'
      }
      if (classification === 'chat') {
        acceptSend(origin, text, images)
      } else if (recordControlSend) {
        // The session-option catalog can recognize controls omitted from the
        // autocomplete catalog (for example Claude `/model` and `/fast`).
        recordCommand(text.trim())
      }
      return 'accepted'
    },
    [
      acceptSend,
      agentRef,
      captureSendOrigin,
      clearDraftForSend,
      client,
      commandSendRef,
      deviceTokenRef,
      enabled,
      handleRef,
      holdUnconfirmedSend,
      onSendError,
      readSeededLaunchDraftSeed,
      restoreRejectedDraft
    ]
  )

  const sendWithOutcome = useCallback(
    (
      text: string,
      images?: string[],
      deadline?: number,
      _attachments?: readonly unknown[],
      sentAt?: number
    ) => sendMessage(text, images, true, true, deadline, undefined, sentAt),
    [sendMessage]
  )

  const send = useCallback(
    async (text: string, images?: string[]): Promise<boolean> =>
      (await sendWithOutcome(text, images)) !== 'rejected',
    [sendWithOutcome]
  )

  // Question answers leave drafts alone but claim the terminal lock to avoid interleaving with image sequences.
  const answerQuestion = useCallback(
    async (text: string): Promise<boolean> => {
      const terminal = handleRef.current
      if (terminal && !acquireMobileNativeChatTerminalWrite(terminal)) {
        onSendError('Answer not sent')
        return false
      }
      try {
        return (await sendMessage(text, undefined, false, true, undefined, true)) === 'accepted'
      } finally {
        if (terminal) {
          releaseMobileNativeChatTerminalWrite(terminal)
        }
      }
    },
    [handleRef, onSendError, sendMessage]
  )

  // Lock option commands against send body/Enter spacing or they can become part of the user prompt.
  const dispatchCommand = useCallback(
    async (
      text: string,
      _options?: { delivery?: CatalogCommandDelivery }
    ): Promise<MobileNativeChatSendOutcome> => {
      const terminal = handleRef.current
      if (terminal && !acquireMobileNativeChatTerminalWrite(terminal)) {
        return 'rejected'
      }
      try {
        if (agentRef.current === 'codex') {
          if (!client || !terminal || !enabled) {
            return 'rejected'
          }
          const deadline = openMobileNativeChatSendBudget()
          const mobileClient = deviceTokenRef.current
            ? { id: deviceTokenRef.current, type: 'mobile' as const }
            : undefined
          if (
            !(await healMobileNativeChatStaleInput({
              client,
              terminal,
              deviceToken: deviceTokenRef.current,
              deadline
            }))
          ) {
            return 'rejected'
          }
          return typeMobileNativeChatCommandWithOutcome({
            client,
            terminal,
            command: text,
            ...(mobileClient ? { mobileClient } : {}),
            deadline
          })
        }
        return await sendMessage(text, undefined, false, false)
      } finally {
        if (terminal) {
          releaseMobileNativeChatTerminalWrite(terminal)
        }
      }
    },
    [client, deviceTokenRef, enabled, handleRef, sendMessage]
  )

  return { send, sendWithOutcome, answerQuestion, dispatchCommand }
}
