import type { AutomationBotTarget } from '../../../../../shared/automations/automation-definition'
import { botOfSession } from '../../../../bots/bot-session-tabs'
import { botGroupRoomChat } from '../../../../bots/bot-group-automation-run'
import { runtimeBotGroups } from '../../../../bots/bot-group-runtime'
import { isBotGroupMemberSession } from '../../../../../shared/bots/bot-group'
import { runtimeChatHost } from '../../../../external-conversations/external-conversation-chat'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { readBotChats } from '../bots-chats'

/**
 * With no --runs-in, a wait or recurring automation made from one of its bot's chats other than its
 * Home Chat runs in that chat, whoever asked. Gone by the time it runs, it runs in the Home Chat.
 * A wait a thread's turn made answers in that thread, as that turn's workers report there. One
 * made from a group room the bot is a member of runs in that room, and is refused once it left.
 */
export async function targetInCallerChat(
  runtime: OrcaRuntimeService,
  caller: string | undefined,
  target: AutomationBotTarget,
  once: boolean
): Promise<AutomationBotTarget> {
  // A recurring thread answer or own agent needs a new conversation; a wait runs in the chat that made it.
  const movable = once
    ? target.runsIn === 'chat'
    : target.runsIn === 'new' && target.resultsTo !== 'thread' && !target.agentSetup
  if (!caller || target.chat || !movable) {
    return target
  }
  if (isBotGroupMemberSession(caller)) {
    const room = botGroupRoomChat(runtimeBotGroups(runtime), { id: target.botId }, caller)
    return room ? { ...target, runsIn: 'chat', chat: { sessionId: caller } } : target
  }
  const bot = botOfSession(runtime.bots, caller)
  if (bot?.id !== target.botId) {
    return target
  }
  const self = (await readBotChats(runtime, bot, caller)).find((chat) => chat.self)
  if (!self || self.home) {
    return target
  }
  const toConversation =
    once &&
    runtime.getExternalConversationSeam()?.conversationTurn(runtimeChatHost(runtime), self.id)
  return {
    ...target,
    runsIn: 'chat',
    chat: { sessionId: self.id, homeIfGone: true, ...(toConversation ? { toConversation } : {}) }
  }
}
