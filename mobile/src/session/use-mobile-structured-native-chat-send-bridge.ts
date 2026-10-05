import { useCallback } from 'react'
import type { AgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import { isStructuredAgentSessionComposerCommand } from '../../../src/shared/structured-agent-session-composer'
import type { NativeChatAsyncAnswerSendResult } from '../../../src/shared/native-chat-async-question-card-state'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'

type StructuredNativeChatAttachment = {
  id?: string
  path: string
  previewUri: string
  contentFingerprint?: string
}

export function useMobileStructuredNativeChatSendBridge(args: {
  agent: AgentSessionHandleProvider
  sendStructured: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredNativeChatAttachment[],
    options?: { queue?: boolean; onAccepted?: (clientMessageId: string) => void }
  ) => Promise<MobileNativeChatSendOutcome>
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
  acceptSend: (origin: MobileNativeChatSendOrigin, text: string, images?: string[]) => void
  holdUnconfirmedSend: (
    origin: MobileNativeChatSendOrigin,
    text: string,
    onUnconfirmed: () => void
  ) => void
  restoreRejectedDraft: (origin: MobileNativeChatSendOrigin, text: string) => void
  onSendError: (message: string) => void
}): {
  send: (text: string, images?: string[]) => Promise<boolean>
  sendWithOutcome: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredNativeChatAttachment[]
  ) => Promise<MobileNativeChatSendOutcome>
  /** An async question answer: an ordinary message that never touches the composer draft. An
   *  accepted one names its journal submission, whose state the card reads from then on. */
  answer: (text: string) => Promise<NativeChatAsyncAnswerSendResult>
} {
  const {
    acceptSend,
    agent,
    captureSendOrigin,
    clearDraftForSend,
    holdUnconfirmedSend,
    onSendError,
    restoreRejectedDraft,
    sendStructured
  } = args
  const sendWithOutcome = useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredNativeChatAttachment[]
    ): Promise<MobileNativeChatSendOutcome> => {
      const origin = captureSendOrigin(text.trimEnd())
      if (!origin) {
        onSendError('Message not sent (disconnected)')
        return 'rejected'
      }
      const isHostCommand = isStructuredAgentSessionComposerCommand(text, agent)
      clearDraftForSend(origin, text)
      const outcome =
        attachments !== undefined
          ? await sendStructured(text, images, deadline, attachments)
          : deadline !== undefined
            ? await sendStructured(text, images, deadline)
            : images !== undefined
              ? await sendStructured(text, images)
              : await sendStructured(text)
      if (outcome === 'accepted') {
        if (!isHostCommand) {
          acceptSend(origin, text.trimEnd(), images)
        }
        return 'accepted'
      }
      if (outcome === 'queued') {
        // The host holds the draft and publishes it as a card above the
        // composer — never an optimistic transcript bubble.
        return 'queued'
      }
      if (outcome === 'unknown') {
        if (isHostCommand) {
          restoreRejectedDraft(origin, text)
          return 'unknown'
        }
        holdUnconfirmedSend(origin, text.trimEnd(), () =>
          onSendError('Delivery unconfirmed — check chat before retrying')
        )
        return 'unknown'
      }
      restoreRejectedDraft(origin, text)
      return 'rejected'
    },
    [
      acceptSend,
      agent,
      captureSendOrigin,
      clearDraftForSend,
      holdUnconfirmedSend,
      onSendError,
      restoreRejectedDraft,
      sendStructured
    ]
  )
  const send = useCallback(
    async (
      text: string,
      images?: string[],
      deadline?: number,
      attachments?: readonly StructuredNativeChatAttachment[]
    ) => (await sendWithOutcome(text, images, deadline, attachments)) !== 'rejected',
    [sendWithOutcome]
  )
  const answer = useCallback(
    async (text: string): Promise<NativeChatAsyncAnswerSendResult> => {
      const origin = captureSendOrigin(text.trimEnd())
      if (!origin) {
        onSendError('Answer not sent (disconnected)')
        return 'rejected'
      }
      const accepted: { clientMessageId?: string } = {}
      // Into the running turn, as the agent's own app delivers an answer, never held to its end.
      const outcome = await sendStructured(text, undefined, undefined, undefined, {
        queue: false,
        onAccepted: (clientMessageId) => {
          accepted.clientMessageId = clientMessageId
        }
      })
      if (outcome === 'accepted') {
        acceptSend(origin, text.trimEnd())
      } else if (outcome === 'unknown') {
        holdUnconfirmedSend(origin, text.trimEnd(), () =>
          onSendError('Delivery unconfirmed — check chat before retrying')
        )
      }
      return outcome === 'accepted' && accepted.clientMessageId !== undefined
        ? { outcome, receipt: accepted.clientMessageId }
        : outcome
    },
    [acceptSend, captureSendOrigin, holdUnconfirmedSend, onSendError, sendStructured]
  )
  return { send, sendWithOutcome, answer }
}
