// TEMPORARY (delete after the next release, with the store's backfill): a bot's threads and runs
// made before the background list are tabless yet open, since a person never closed one.
import type { Bot } from '../../shared/bot-types'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { AgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store'
import { bearsBotHomeName } from './bot-home-chat-name'
import { isInBotHome } from './bot-home-membership'

export function backfillBotBackgroundChats(
  store: Pick<AgentSessionRecordStore, 'backfillBackgroundSessions'>,
  bots: () => readonly Pick<Bot, 'folderWorkspaceId'>[]
): Promise<string[]> {
  return store.backfillBackgroundSessions(
    (conversation) =>
      isInBotHome({ list: bots }, conversation.location) &&
      // A tabless Home chat is one a reset retired. This runs at host install, before any Chat
      // open releases a replaced Home's name, so every replaced Home still bears it here.
      !bearsBotHomeName(conversation)
  )
}

/** Runs on the installed chat host; a failure only leaves those chats' mail waiting. */
export async function backfillInstalledBotBackgroundChats(
  bots: () => readonly Pick<Bot, 'folderWorkspaceId'>[]
): Promise<void> {
  const host = getStructuredAgentSessionHost()
  if (!host || host.deps.store.readOnly) {
    return
  }
  await backfillBotBackgroundChats(host.deps.store, bots).catch((error: unknown) =>
    host.deps.logger.warn('bot chat background backfill failed', {
      scope: 'bot-background-backfill',
      error
    })
  )
}
