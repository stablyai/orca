import type { AutomationBotTarget } from '../../../../../shared/automations/automation-definition'
import type { BotRequestAsker } from '../../../../../shared/bots/bot-acts-for'
import { botOfSession } from '../../../../bots/bot-session-tabs'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { readBotChats } from '../bots-chats'
import { readBotTurn } from '../orchestration/messaging/bot-recipient'

// Anyone the record doesn't name as the owner, a person whose role the cloud didn't say included.
const isTeammate = (asker: BotRequestAsker) => asker.kind === 'person' && asker.role !== 'owner'

/** Whether the chat's turn is a teammate's request; one Orca can't read is not. */
async function askedByTeammate(runtime: OrcaRuntimeService, sessionId: string): Promise<boolean> {
  return readBotTurn(runtime, runtime.getOrchestrationDb(), sessionId)
    .then(({ turn, actsFor }) => (turn.askers.length > 0 ? turn.askers : actsFor).some(isTeammate))
    .catch(() => false)
}

/**
 * With no --runs-in, a wait made from one of its bot's chats other than its Home Chat runs in that
 * chat, and so does a teammate's recurring automation, whose results then reach them there; the
 * owner's own keep a new conversation each run. Gone by the time it runs, it runs in the Home Chat.
 */
export async function targetInCallerChat(
  runtime: OrcaRuntimeService,
  caller: string | undefined,
  target: AutomationBotTarget,
  once: boolean
): Promise<AutomationBotTarget> {
  // A new conversation is what a thread answer and an automation's own agent need.
  const movable = once
    ? target.runsIn === 'chat'
    : target.runsIn === 'new' && target.resultsTo !== 'thread' && !target.agentSetup
  if (!caller || target.chat || !movable) {
    return target
  }
  const bot = botOfSession(runtime.bots, caller)
  if (bot?.id !== target.botId) {
    return target
  }
  const self = (await readBotChats(runtime, bot, caller)).find((chat) => chat.self)
  if (!self || self.home || (!once && !(await askedByTeammate(runtime, caller)))) {
    return target
  }
  return { ...target, runsIn: 'chat', chat: { sessionId: self.id, homeIfGone: true } }
}
