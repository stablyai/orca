import { randomUUID } from 'node:crypto'
import type { Bot } from '../../shared/bot-types'
import {
  botOnSetup,
  sameBotAgentSetup,
  type BotAgentSetup
} from '../../shared/bots/bot-agent-setup'
import type { BotController } from './bot-controller'
import type { StructuredAgentTurnHost } from '../runtime/orchestration/turn-delivery/send-agent-turn'
import type { StructuredAgentSessionCloseOutcome } from '../runtime/agent-session/lifecycle/structured-agent-session-close'
import { carryQueuedMessages, type QueuedCarryHost } from './bot-chat-queued-carry'
import { nameNewHome, type BotHomeHost } from './bot-home-chat-name'

export type BotChatHost = StructuredAgentTurnHost & BotHomeHost & QueuedCarryHost

export type BotChatDependencies = {
  bots: Pick<BotController, 'list' | 'setChatSession'> & Partial<Pick<BotController, 'update'>>
  /** Installs the native-chat host on first use. */
  host: () => Promise<BotChatHost>
  /** Creates `sessionId` at rest in the bot's home; its first message starts it. */
  createChat: (bot: Bot, sessionId: string, deferTab?: true) => Promise<void>
  /** Shows the Chat's tab again if it was closed. */
  showTab: (bot: Bot, sessionId: string) => Promise<void>
  /** Stops the Chat and removes its tab; its history stays. A close that cannot be proven keeps the tab. */
  closeChat: (
    sessionId: string
  ) => Promise<Pick<StructuredAgentSessionCloseOutcome, 'stopped' | 'reason'>>
  /** Ends the mail a replaced Chat never read; its senders hear the bot started a new Chat. */
  dropUnreadMail: (bot: Bot, replacedSessionId: string | null) => Promise<void>
}

async function closeHome(deps: BotChatDependencies, sessionId: string): Promise<void> {
  const closed = await deps.closeChat(sessionId)
  if (!closed.stopped) {
    throw new Error(`bot_chat_close_failed: ${closed.reason ?? 'unknown'}`)
  }
}

async function finishReplacement(
  deps: BotChatDependencies,
  host: BotChatHost,
  bot: Bot,
  sessionId: string
): Promise<void> {
  await carryQueuedMessages(host, bot.chatSessionId, sessionId)
  await deps.dropUnreadMail(bot, bot.chatSessionId)
  await nameNewHome(host, { ...bot, chatSessionId: sessionId }, bot.chatSessionId)
}

/** Retire the old Home first for a reset. A failure leaves the original pointer for retry. */
export async function replaceBotHomeChat(
  deps: BotChatDependencies,
  host: BotChatHost,
  bot: Bot
): Promise<string> {
  if (bot.chatSessionId && host.deps.store.getConversation(bot.chatSessionId)) {
    await closeHome(deps, bot.chatSessionId)
  }
  const sessionId = randomUUID()
  await deps.createChat(bot, sessionId)
  await deps.bots.setChatSession(bot.id, sessionId)
  await finishReplacement(deps, host, bot, sessionId)
  return sessionId
}

export async function switchBotHomeChat(
  deps: BotChatDependencies,
  host: BotChatHost,
  bot: Bot,
  sourceSessionId: string,
  setup: BotAgentSetup,
  handoff: (sessionId: string) => Promise<unknown>
): Promise<string> {
  if (!deps.bots.update || bot.chatSessionId !== sourceSessionId || bot.agent === setup.agent) {
    throw new Error('bot_home_changed')
  }
  const sessionId = randomUUID()
  const next = botOnSetup(bot, setup)
  await deps.createChat(next, sessionId, true)
  let sourceClosed = false
  try {
    await handoff(sessionId)
    await closeHome(deps, sourceSessionId)
    sourceClosed = true
    await deps.bots.update(bot.id, (current) => {
      if (current.chatSessionId !== sourceSessionId || !sameBotAgentSetup(current, bot)) {
        throw new Error('bot_home_changed')
      }
      return { agent: setup.agent, launch: setup.launch ?? null, chatSessionId: sessionId }
    })
  } catch (error) {
    await deps.closeChat(sessionId).catch(() => undefined)
    if (sourceClosed) {
      await deps.showTab(bot, sourceSessionId).catch(() => undefined)
    }
    throw error
  }
  await finishReplacement(deps, host, bot, sessionId)
  return sessionId
}
