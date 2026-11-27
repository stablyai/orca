// A bot run whose prompt no chat took: its Couldn't start card goes in the chat it was meant for, else
// the bot's Chat, so the owner sees why there and can send it again.
import type { Bot } from '../../shared/bot-types'
import type { AgentJournalAutomationRunNotStartedItem } from '../../shared/agent-journal-orca-card-items'
import type { BotRunChat } from '../automations/bot-automation-launch'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { appendOrcaChatCard } from '../runtime/orca-chat-card'
import { botChatTakingMail } from '../runtime/rpc/methods/bots-chats'
import { requireStructuredHost, type botChatSessions } from './bot-chat-session'

export type BotRunNotStartedDependencies = {
  chats: Pick<ReturnType<typeof botChatSessions>, 'ensure'>
  /** The session of one of the bot's chats, or null when it is gone. */
  chatSession: (bot: Bot, chatId: string) => Promise<string | null>
  sessionExists: (sessionId: string) => Promise<boolean>
  append: (sessionId: string, card: AgentJournalAutomationRunNotStartedItem) => void
}

async function cardChat(
  deps: BotRunNotStartedDependencies,
  bot: Bot,
  destination: BotRunChat
): Promise<string> {
  const meant =
    destination.kind === 'session'
      ? destination.sessionId
      : destination.kind === 'bot-chat'
        ? await deps.chatSession(bot, destination.chatId)
        : null
  return meant && (await deps.sessionExists(meant)) ? meant : deps.chats.ensure(bot.id)
}

/** Never fails the run it reports. */
export async function showBotRunNotStarted(
  deps: BotRunNotStartedDependencies,
  bot: Bot,
  destination: BotRunChat,
  card: AgentJournalAutomationRunNotStartedItem
): Promise<void> {
  try {
    deps.append(await cardChat(deps, bot, destination), card)
  } catch (error) {
    console.warn("[bots] could not show a run that couldn't start", error)
  }
}

export function runtimeBotRunNotStarted(
  runtime: OrcaRuntimeService,
  chats: BotRunNotStartedDependencies['chats']
): BotRunNotStartedDependencies {
  return {
    chats,
    chatSession: async (bot, chatId) =>
      (await botChatTakingMail(runtime, bot, chatId))?.sessionId ?? null,
    sessionExists: async (sessionId) =>
      Boolean((await requireStructuredHost(runtime)).deps.store.getConversation(sessionId)),
    append: (sessionId, card) =>
      appendOrcaChatCard(sessionId, card, "showing a run that couldn't start")
  }
}
