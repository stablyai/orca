// Home names the bot's one Chat; a Home Chat a new one replaced becomes an ordinary chat of the bot's.
import type { Bot } from '../../shared/bot-types'
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { createCanonicalOrcaSessionResolver } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'

/** The Chat's tab name. */
export const BOT_CHAT_NAME = 'Home'

/** A chat Orca named Home: the bot's Chat, or one replaced before replaced Homes were renamed. */
export function bearsBotHomeName(conversation: {
  conversationName?: string
  conversationNameSource?: 'user'
}): boolean {
  return (
    conversation.conversationName === BOT_CHAT_NAME &&
    conversation.conversationNameSource === 'user'
  )
}

export type BotHomeHost = Pick<
  StructuredAgentSessionHost,
  'setUserConversationName' | 'isSessionTabVisible' | 'setSessionTabVisibility'
> & {
  deps: {
    store: Pick<
      StructuredAgentSessionHost['deps']['store'],
      'listConversations' | 'lineageRevision'
    >
  }
}

/** A new Home Chat takes the name. The Home it replaced keeps no tab, even when its stop won but
 *  its tab bookkeeping lost a race, so no restore reopens it; and it gives up the name. */
export async function nameNewHome(
  host: BotHomeHost,
  bot: Bot & { chatSessionId: string },
  replaced: string | null | undefined
): Promise<void> {
  await host.setUserConversationName(bot.chatSessionId, BOT_CHAT_NAME, 'rename')
  if (replaced && host.isSessionTabVisible(replaced)) {
    await host.setSessionTabVisibility(replaced, false)
  }
  await releaseReplacedHomes(host, bot)
}

/** Every Home in the bot's home but its Chat gives up the name and is named from its content, as
 *  side chats are. Naming is metadata: a chat that cannot be renamed keeps its name, blocking nothing. */
export async function releaseReplacedHomes(host: BotHomeHost, bot: Bot): Promise<void> {
  const home = folderWorkspaceKey(bot.folderWorkspaceId)
  const resolve = createCanonicalOrcaSessionResolver({
    listRecords: host.deps.store.listConversations,
    lineageRevision: host.deps.store.lineageRevision
  })
  // By /clear root, so a Chat continued by /clear stays the Chat.
  const rootOf = (id: string): string => (isOrcaSessionId(id) ? resolve(id) : id)
  const chat = bot.chatSessionId ? rootOf(bot.chatSessionId) : null
  for (const conversation of host.deps.store.listConversations()) {
    if (
      conversation.location.workspaceId === home &&
      bearsBotHomeName(conversation) &&
      rootOf(conversation.sessionId) !== chat
    ) {
      await host
        .setUserConversationName(conversation.sessionId, BOT_CHAT_NAME, 'release')
        .catch((error: unknown) =>
          console.warn('[bots] renaming a replaced Home Chat failed:', error)
        )
    }
  }
}
