import { NOT_FAILED_REFUSAL } from '../../shared/connectors/connector-cloud-contract'
import {
  chatIsIdle,
  currentChat,
  type ConversationChat,
  type ConversationChatHost
} from './external-conversation-chat'
import { refused, type Delivery } from './external-conversation-types'

/** Idle with its newest turn failed and not resumed: what a thread's Resume continues. As a person's
 *  message the continue lifts the queue's pause, so what waited there runs after it. An unreadable
 *  chat is taken as not. */
export async function chatAwaitsResume(
  chat: ConversationChat | null,
  sessionId: string
): Promise<boolean> {
  if (!chat || !chatIsIdle(chat, sessionId)) {
    return false
  }
  try {
    return await (await chat.conversation(sessionId)).journal.queuedMessages.failureHolds()
  } catch {
    return false
  }
}

/** A resume to a chat resumed, answered or replaced since its press: refused, never run twice. */
export async function resumeRefusal(
  message: { resume?: true },
  chats: ConversationChatHost | undefined,
  sessionId: string
): Promise<Delivery | null> {
  return message.resume && !(await chatAwaitsResume(currentChat(chats), sessionId))
    ? refused(NOT_FAILED_REFUSAL)
    : null
}
