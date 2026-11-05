import type { MobileNativeChatMessageSend } from './transcript/use-mobile-native-chat-message-send'
import type { MobileNativeChatSendOrigin } from './mobile-native-chat-pending-echo'
import type { MobileNativeChatSendOutcome } from './mobile-native-chat-send'

export function mobileTerminalChatQueueSend(
  enqueue: (text: string) => Promise<MobileNativeChatSendOutcome>,
  capture: (text: string, sentAt?: number) => MobileNativeChatSendOrigin | null,
  clear: (origin: MobileNativeChatSendOrigin, text: string) => void,
  fallback: MobileNativeChatMessageSend['sendWithOutcome']
): Pick<MobileNativeChatMessageSend, 'send' | 'sendWithOutcome'> {
  const sendWithOutcome: MobileNativeChatMessageSend['sendWithOutcome'] = async (
    text,
    images,
    deadline,
    attachments,
    sentAt
  ) => {
    if (images?.length || text.trimStart().startsWith('/')) {
      return fallback(text, images, deadline, attachments, sentAt)
    }
    const origin = capture(text, sentAt)
    const outcome = await enqueue(text)
    if (outcome !== 'rejected' && origin) {
      clear(origin, text)
    }
    return outcome
  }
  return {
    sendWithOutcome,
    send: async (text, images) => (await sendWithOutcome(text, images)) !== 'rejected'
  }
}
