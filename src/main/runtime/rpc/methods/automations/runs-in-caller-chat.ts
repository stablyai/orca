import type { AutomationBotTarget } from '../../../../../shared/automations/automation-definition'
import { botOfSession } from '../../../../bots/bot-session-tabs'
import { botGroupRoomChat } from '../../../../bots/bot-group-automation-run'
import { runtimeBotGroups } from '../../../../bots/bot-group-runtime'
import { isBotGroupMemberSession } from '../../../../../shared/bots/bot-group'
import { runtimeChatHost } from '../../../../external-conversations/external-conversation-chat'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { readBotChats } from '../bots-chats'
import { botHomeOfChat } from '../../../../bots/bot-conversation-acts-for'

/** An automation made from a teammate's chat of its agent is theirs, whatever it runs in: stamped with
 *  their account, so its runs use their Home and act for them. The owner's are left as they are. */
export function withCallerHome(
  runtime: OrcaRuntimeService,
  caller: string | undefined,
  target: AutomationBotTarget
): AutomationBotTarget {
  const bot = caller ? botOfSession(runtime.bots, caller) : null
  if (!caller || bot?.id !== target.botId) {
    return target
  }
  const home = botHomeOfChat(runtime, bot, caller)
  return home === 'owner' ? target : { ...target, home: home.accountId }
}

/**
 * With no --runs-in, a wait or recurring automation made from one of its agent's chats other than a
 * Home Chat runs in that chat, whoever asked. Gone by the time it runs, it runs in the Home Chat of
 * the person it is for.
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
