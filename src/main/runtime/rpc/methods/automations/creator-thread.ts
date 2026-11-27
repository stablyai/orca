// The thread a bot's turn was answering when it made an automation: recorded on the target, which
// the host then routes to answer under it (bot-automation-origin-thread.ts).
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
  caller: string | undefined,
  botId: string
): Promise<AutomationOriginThread | null> {
  const seam = runtime.getExternalConversationSeam()
  if (!caller || !seam) {
    return null
  }
  const bot = botOfSession(runtime.bots, caller)
  if (bot?.id !== botId) {
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
