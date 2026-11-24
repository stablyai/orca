// A teammate's New chat on a shared bot: their own chat on the bot's agent, acting for them. An empty
// chat is reused only when it is already theirs, never the owner's or another teammate's.
import type { Bot } from '../../../shared/bot-types'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { startBotSession } from '../bot-chat-session'
import { openEmptyBotChat, runtimeBotChatTreeHost } from '../bot-chat-tree-host'
import { botShareAsker, emptyChatReusableBy } from './bot-share-chats'
import { openBotShareNewChat } from './bot-share-new-chats'

export async function startBotShareSession(
  runtime: OrcaRuntimeService,
  bot: Bot,
  scope: BotShareCallerScope,
  /** Their device's id for this new chat: one chat per id, whether it comes live or held. */
  newChatId?: string
): Promise<string> {
  if (!newChatId) {
    return await startNewBotShareSession(runtime, bot, scope)
  }
  return await openBotShareNewChat(
    runtime.getOrchestrationDb(),
    { botId: bot.id, accountId: scope.accountId, newChatId },
    () => startNewBotShareSession(runtime, bot, scope)
  )
}

async function startNewBotShareSession(
  runtime: OrcaRuntimeService,
  bot: Bot,
  scope: BotShareCallerScope
): Promise<string> {
  const empty = await openEmptyBotChat(
    runtimeBotChatTreeHost(runtime),
    bot,
    emptyChatReusableBy(runtime, scope)
  ).catch((error: unknown) => {
    console.error('[bots] failed to look for a teammate’s empty chat to reuse:', error)
    return null
  })
  return (
    empty ?? (await startBotSession(runtime, bot, { actsFor: { actsFor: [botShareAsker(scope)] } }))
  )
}
