import { useCallback } from 'react'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'
import type { MobileNativeChatSendOrigin } from './use-mobile-native-chat-drafts'

type StructuredNativeChatAttachment = {
  id?: string
  path: string
  previewUri: string
}

export function useMobileStructuredNativeChatSendBridge(args: {
  sendStructured: (
    text: string,
    images?: string[],
    deadline?: number,
    attachments?: readonly StructuredNativeChatAttachment[]
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
} {
  const {
    acceptSend,
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
        acceptSend(origin, text.trimEnd(), images)
        return 'accepted'
      }
      if (outcome === 'unknown') {
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
