import { NOT_FAILED_REFUSAL } from '../../shared/connectors/connector-cloud-contract'
import type { ConversationChat, ConversationChatHost } from './external-conversation-chat'
import { refused, type Delivery } from './external-conversation-types'
import { turnOpenerOf } from './external-conversation-ended-turn'
import type { LinkedConversation } from './external-conversation-links'
import { conversationHeardTurn } from './external-conversation-turn-opener'

/** Idle with its newest turn failed and not resumed: what a thread's Resume continues. As a person's
 *  message the continue lifts the queue's pause, so what waited there runs after it. An unreadable
 *  chat is taken as not. `conversation`: the thread pressing it, which only continues a restart's
 *  cut of a turn it heard (a shared chat's turn begun in Orca is not its to continue). */
export async function chatAwaitsResume(
  chat: ConversationChat | null,
  sessionId: string,
  conversation?: LinkedConversation
): Promise<boolean> {
  if (!chat) {
    return false
  }
  try {
    // Live work, not the published view: a send admitted a moment ago already holds the chat.
    const busy = async () => {
      const work = await chat.currentWork(sessionId)
      return Boolean(work && (work.working() || work.hasActionablePrompt()))
    }
    if (await busy()) {
      return false
    }
    const { journal } = await chat.conversation(sessionId)
    // Any failed pause, including one that lets other agents' mail run past it (#47220).
    const pauses = await journal.queuedMessages.pauses()
    if (pauses.some((pause) => pause.reason === 'failed')) {
      return true
    }
    // Or its newest turn an Orca quit, crash or update cut, which its conversation reads as failed.
    const cut = await journal.reads.orcaStopCut()
    if (!cut || !conversation) {
      return cut !== null
    }
    if (!conversationHeardTurn(conversation, await turnOpenerOf(chat, sessionId, cut.turnItemId))) {
      return false
    }
    // A send admitted during that read moved the chat on.
    return !(await busy()) && (await journal.reads.orcaStopCut())?.turnItemId === cut.turnItemId
  } catch {
    return false
  }
}

/** A resume to a chat resumed, answered or replaced since its press: refused, never run twice. The
 *  chat host is installed first, as a delivery does, so one not yet opened since a restart counts. */
export async function resumeRefusal(
  message: { resume?: true },
  chats: ConversationChatHost | undefined,
  sessionId: string,
  conversation?: LinkedConversation
): Promise<Delivery | null> {
  if (!message.resume) {
    return null
  }
  const chat = (await chats?.ensure()) ?? null
  if (!chat) {
    return refused('agent_not_reachable')
  }
  return (await chatAwaitsResume(chat, sessionId, conversation))
    ? null
    : refused(NOT_FAILED_REFUSAL)
}
