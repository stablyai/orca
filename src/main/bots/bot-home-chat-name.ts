// A Home Chat bears its person's Home name exactly while a pointer names it; a Home a new one
// replaced gives the name up and becomes an ordinary chat of the agent's.
import type { Bot } from '../../shared/bot-types'
import {
  BOT_HOME_NAME,
  botHomes,
  legacyTeammateHomeNames,
  type BotHomeOf
} from '../../shared/bots/bot-home-of'
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-host'
import { createCanonicalOrcaSessionResolver } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'

/** A chat Orca named Home: the bot's Chat, or one replaced before replaced Homes were renamed. */
export function bearsBotHomeName(conversation: {
  conversationName?: string
  conversationNameSource?: 'user'
}): boolean {
  return (
    conversation.conversationName === BOT_HOME_NAME &&
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

/** A chat's /clear root, as the host's records chain it. */
export function botHomeRootOf(host: Pick<BotHomeHost, 'deps'>): (sessionId: string) => string {
  const resolve = createCanonicalOrcaSessionResolver({
    listRecords: host.deps.store.listConversations,
    lineageRevision: host.deps.store.lineageRevision
  })
  return (id) => (isOrcaSessionId(id) ? resolve(id) : id)
}

/** A new Home Chat: the owner's is named Home; a teammate's is stored unnamed, and every read titles
 *  it from their share row (agent-session-record-home-names.ts). The owner's Home it replaced keeps no tab,
 *  even when its stop won but its tab bookkeeping lost a race, so no restore reopens it; and it gives
 *  up any name Orca gave it (older builds saved "<name>’s Home"), so it is named from its content. */
export async function nameNewHome(
  host: BotHomeHost,
  bot: Bot,
  of: BotHomeOf,
  sessionId: string,
  replaced: string | null | undefined
): Promise<void> {
  if (of === 'owner') {
    await host.setUserConversationName(sessionId, BOT_HOME_NAME, 'rename')
  }
  // A teammate's Home has no host tab of its own: one there is the owner's, opened by him.
  if (of === 'owner' && replaced && host.isSessionTabVisible(replaced)) {
    await host.setSessionTabVisibility(replaced, false)
  }
  if (replaced && of !== 'owner') {
    for (const name of legacyTeammateHomeNames(bot, of)) {
      await releaseName(host, replaced, name)
    }
  }
  await releaseReplacedHomes(host, bot)
}

/** Every chat in the agent's home named "Home" but a current Home gives up the name and is named from
 *  its content, as side chats are: the sweep for Homes older builds replaced. */
export async function releaseReplacedHomes(host: BotHomeHost, bot: Bot): Promise<void> {
  const home = folderWorkspaceKey(bot.folderWorkspaceId)
  // By /clear root, so a Home continued by /clear stays a Home.
  const rootOf = botHomeRootOf(host)
  const current = new Set(botHomes(bot).map((entry) => rootOf(entry.sessionId)))
  for (const conversation of host.deps.store.listConversations()) {
    if (
      conversation.location.workspaceId === home &&
      bearsBotHomeName(conversation) &&
      !current.has(rootOf(conversation.sessionId))
    ) {
      await releaseName(host, conversation.sessionId, BOT_HOME_NAME)
    }
  }
}

/** Naming is metadata: a chat that cannot be renamed keeps its name, blocking nothing. */
async function releaseName(host: BotHomeHost, sessionId: string, name: string): Promise<void> {
  await host
    .setUserConversationName(sessionId, name, 'release')
    .catch((error: unknown) => console.warn('[bots] renaming a replaced Home Chat failed:', error))
}
