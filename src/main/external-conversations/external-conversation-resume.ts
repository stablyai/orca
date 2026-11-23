import { NOT_FAILED_REFUSAL } from '../../shared/connectors/connector-cloud-contract'
import type { ConversationChat, ConversationChatHost } from './external-conversation-chat'
import { refused, type Delivery } from './external-conversation-types'

/** Idle with its newest turn failed and not resumed: what a thread's Resume continues. As a person's
 *  message the continue lifts the queue's pause, so what waited there runs after it. An unreadable
 *  chat is taken as not. */
export async function chatAwaitsResume(
  chat: ConversationChat | null,
  sessionId: string
): Promise<boolean> {
  if (!chat) {
    return false
  }
  try {
    // Live work, not the published view: a send admitted a moment ago already holds the chat.
    const work = await chat.currentWork(sessionId)
    if (work && (work.working() || work.hasActionablePrompt())) {
      return false
    }
    return await (await chat.conversation(sessionId)).journal.queuedMessages.failureHolds()
  } catch {
    return false
  }
}

/** A resume to a chat resumed, answered or replaced since its press: refused, never run twice. The
 *  chat host is installed first, as a delivery does, so one not yet opened since a restart counts. */
export async function resumeRefusal(
  message: { resume?: true },
  chats: ConversationChatHost | undefined,
  sessionId: string
): Promise<Delivery | null> {
  if (!message.resume) {
    return null
  }
  const chat = (await chats?.ensure()) ?? null
  if (!chat) {
    return refused('agent_not_reachable')
  }
  return (await chatAwaitsResume(chat, sessionId)) ? null : refused(NOT_FAILED_REFUSAL)
}
