// An automation a bot's turn makes while it answers a thread answers under that thread: the person
// asked there, so its result belongs there, never as a new post beside it in the same channel.
import type {
  AutomationBotTarget,
  AutomationOriginThread
} from '../../../../../shared/automation-bot-target'
import { originThreadText } from '../../../../../shared/automations/automation-results-place'
import { legacyPlaceOf } from '../../../../../shared/connector-place-names'
import { slackPlaceOf } from '../../../../../shared/connectors/slack-mirror-state'
import { botOfSession } from '../../../../bots/bot-session-tabs'
import { runtimeChatHost } from '../../../../external-conversations/external-conversation-chat'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { readBotChats } from '../bots-chats'

/** The bot's chat that made the automation, and the thread its running turn answers. */
export type CreatorThread = { sessionId: string; thread: AutomationOriginThread }

/** What the caller asked for, as the CLI sent it. */
export type AskedTarget = {
  /** --runs-in was given. */
  runsInAsked: boolean
}

export type OriginThreadTarget = { target: AutomationBotTarget; note?: string }

/** Whether a channel the results name is the thread's own channel: by id, link, ref or #name. */
export function namesThreadChannel(channel: string, thread: AutomationOriginThread): boolean {
  if (thread.source !== 'slack') {
    return false
  }
  const channelId = slackPlaceOf(thread.externalId)?.channelId
  const value = channel.trim()
  // A ref (slack:T0123:C0123) ends in the channel id.
  const id = legacyPlaceOf('slack', value) ?? legacyPlaceOf('slack', value.split(':').at(-1) ?? '')
  if (channelId && id === channelId) {
    return true
  }
  const name = value.startsWith('#') ? value : `#${value}`
  return Boolean(thread.place && name.toLowerCase() === thread.place.toLowerCase())
}

/** Results the person sent somewhere else by name: they go there, not to the thread. */
function sentElsewhere(target: AutomationBotTarget, creator: CreatorThread): boolean {
  const { resultsTo } = target
  if (resultsTo === 'none') {
    return true
  }
  if (typeof resultsTo === 'object') {
    return 'linearIssue' in resultsTo || !namesThreadChannel(resultsTo.channel, creator.thread)
  }
  // Another chat chosen by id keeps a result that stays in Orca there.
  return (
    resultsTo === 'chat' &&
    target.runsIn === 'chat' &&
    target.chat !== undefined &&
    target.chat.sessionId !== creator.sessionId
  )
}

/**
 * The target an automation with no events gets when a thread's turn made it. It answers under the
 * thread unless its results go to another place by name: in the chat that made it, so `bot reply`
 * posts there mid-run and the final message is the chat's own answer; or, when it can't run there
 * (its own agent, or another chat chosen by id), by posting its result into the thread.
 */
export function answerInOriginThread(
  target: AutomationBotTarget,
  creator: CreatorThread,
  asked: AskedTarget
): OriginThreadTarget {
  const { thread } = creator
  if (sentElsewhere(target, creator)) {
    return { target: { ...target, originThread: thread } }
  }
  const where = originThreadText(thread)
  // A channel named besides is the thread's own: the thread answer covers it.
  const sameChannel = typeof target.resultsTo === 'object' ? ['--results-to'] : []
  const ownChat =
    target.runsIn === 'chat' && target.chat && target.chat.sessionId !== creator.sessionId
  if (target.agentSetup || ownChat) {
    return {
      target: { ...target, resultsTo: 'thread', originThread: thread },
      ...(sameChannel.length > 0 ? { note: overridden(where, sameChannel) } : {})
    }
  }
  const flags = [
    ...(asked.runsInAsked && target.chat?.sessionId !== creator.sessionId ? ['--runs-in'] : []),
    ...sameChannel
  ]
  return {
    target: {
      ...target,
      runsIn: 'chat',
      chat: { sessionId: creator.sessionId, homeIfGone: true, toConversation: true },
      resultsTo: 'chat',
      originThread: thread
    },
    ...(flags.length > 0 ? { note: overridden(where, flags, true) } : {})
  }
}

function overridden(where: string, flags: string[], inChat = false): string {
  const how = inChat ? 'runs in this chat and answers' : 'posts its result'
  return `Made while answering ${where}, so it ${how} there; ${flags.join(' and ')} didn't change that. To post in another channel instead, name it with --results-to channel:<channel>.`
}

/** The bot's own chat (not its Home Chat) whose running turn its thread owns; null otherwise. */
export async function creatorThreadOf(
  runtime: OrcaRuntimeService,
  caller: string | undefined,
  botId: string
): Promise<CreatorThread | null> {
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
  const conversation = runtime.chatConversation(self.id)
  return conversation
    ? {
        sessionId: self.id,
        thread: {
          ...conversation.key,
          ...(conversation.place ? { place: conversation.place } : {})
        }
      }
    : null
}
