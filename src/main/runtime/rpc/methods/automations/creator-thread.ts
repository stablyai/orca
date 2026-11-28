// The thread a bot's turn was answering when it made an automation, recorded on the target so the
// host routes it to answer there (bot-automation-origin-thread.ts).
import type { AutomationOriginThread } from '../../../../../shared/automation-bot-target'
import { botOfSession } from '../../../../bots/bot-session-tabs'
import { runtimeChatHost } from '../../../../external-conversations/external-conversation-chat'
import { chatConversation } from '../../../../external-conversations/external-conversation-links'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { readBotChats } from '../bots-chats'

/** The thread the bot's own chat (not its Home Chat) answers, when its running turn is that
 *  thread's; null otherwise. */
export async function creatorThreadOf(
  runtime: OrcaRuntimeService,
  caller: string,
  botId: string
): Promise<AutomationOriginThread | null> {
  const seam = runtime.getExternalConversationSeam()
  const bot = seam ? botOfSession(runtime.bots, caller) : null
  if (!seam || bot?.id !== botId) {
    return null
  }
  const self = (await readBotChats(runtime, bot, caller)).find((chat) => chat.self)
  if (!self || self.home || !seam.conversationTurn(runtimeChatHost(runtime), self.id)) {
    return null
  }
  const conversation = chatConversation(runtime.requireStore(), self.id)
  return conversation
    ? {
        ...conversation.key,
        ...(conversation.place ? { place: conversation.place } : {}),
        sessionId: self.id
      }
    : null
}
