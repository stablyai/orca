// A teammate's Activity on the shared bot: built as the owner's is, from the teammate's own chats alone,
// so only work those chats started shows. The owner's chats, automations, waits and Up next never do.
import type { Bot } from '../../../shared/bot-types'
import type { BotActivityRead } from '../../../shared/bots/bot-activity-schema'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { readBotChats } from '../../runtime/rpc/methods/bots-chats'
import {
  lineageLiveSession,
  readAgentSessionRecordStore
} from '../../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { readBotActivity, runtimeBotActivityHost, type BotActivityHost } from '../bot-activity-host'
import { botShareChatIsTheirs } from './bot-share-chats'

export async function readBotShareActivity(
  runtime: OrcaRuntimeService,
  scope: BotShareCallerScope,
  base: BotActivityHost = runtimeBotActivityHost(runtime)
): Promise<BotActivityRead> {
  const bot = runtime.bots.list().find((entry) => entry.id === scope.botId)
  if (!bot) {
    throw new Error('bot_not_found')
  }
  const owns = botShareChatIsTheirs(runtime, scope)
  const chats = (await readBotChats(runtime, bot, null)).filter((chat) => owns(chat.id))
  const store = readAgentSessionRecordStore()
  const theirs = chats.map((chat) => ({
    // A /clear moves a chat to a new session; its workers are the live one's.
    sessionId: (store ? lineageLiveSession(store, chat.id)?.sessionId : undefined) ?? chat.id,
    title: chat.title ?? ''
  }))
  // Not the shared build cache: that one holds the owner's rows.
  return readBotActivity(botShareActivityHost(base, bot, theirs), bot.id)
}

/** The owner's Activity host with the teammate's chats as the bot's only sessions, and none of the
 *  owner's automations, threads, handed workspaces or Up next. */
export function botShareActivityHost(
  base: BotActivityHost,
  bot: Bot,
  theirs: readonly { sessionId: string; title: string }[]
): BotActivityHost {
  return {
    ...base,
    bots: () => [bot],
    chatTabs: async () => theirs,
    // Their thread chats are among their chats; another person's threads are not.
    externalConversations: () => [],
    automations: () => [],
    automationRuns: () => new Map(),
    handedWorktreeIds: undefined,
    pairedHandedAgents: undefined,
    upNext: undefined
  }
}
