import { useCallback } from 'react'
import type { AgentSessionHandleProvider } from '../../../src/shared/agent-session-provider-handle'
import { isStructuredAgentSessionComposerCommand } from '../../../src/shared/structured-agent-session-composer'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileStructuredSendResult } from './mobile-structured-agent-session-send'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'

type StructuredNativeChatAttachment = {
  id?: string
  path: string
  previewUri: string
}

export function useMobileStructuredNativeChatSendBridge(args: {
  agent: AgentSessionHandleProvider
  sendStructured: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredNativeChatAttachment[]
  ) => Promise<MobileStructuredSendResult>
  captureSendOrigin: (text: string) => MobileNativeChatSendOrigin | null
  clearDraftForSend: (origin: MobileNativeChatSendOrigin, text: string) => void
  acceptSend: (
    origin: MobileNativeChatSendOrigin,
    text: string,
    images?: string[],
    clientMessageId?: string
  ) => void
  holdUnconfirmedSend: (
    origin: MobileNativeChatSendOrigin,
    text: string,
    onUnconfirmed: () => void,
    clientMessageId?: string
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
      const { outcome, clientMessageId } =
        attachments !== undefined
          ? await sendStructured(text, images, deadline, attachments)
          : deadline !== undefined
            ? await sendStructured(text, images, deadline)
            : images !== undefined
              ? await sendStructured(text, images)
              : await sendStructured(text)
      // Its own row settles the bubble or the hold, whatever its text, place or state.
      const ownId = clientMessageId ?? undefined
      if (outcome === 'accepted' || outcome === 'recorded-unsent') {
        // A recorded, rejected send is drawn as not sent; the bubble keeps its local photo until
        // that row arrives.
        if (!isHostCommand) {
          acceptSend(origin, text.trimEnd(), images, ownId)
        }
        return outcome
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
        holdUnconfirmedSend(
          origin,
          text.trimEnd(),
          () => onSendError('Delivery unconfirmed — check chat before retrying'),
          ownId
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
  return { send, sendWithOutcome }
}
