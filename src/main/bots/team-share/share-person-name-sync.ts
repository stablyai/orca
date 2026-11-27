// A share's person name has one source, the share row. Nothing stored follows it but each device row's
// name, kept only for older builds; a teammate Home's title is read from the share row on every
// record read. A name change only tells what is showing it, and only when the chat host is open.
import type { Bot } from '../../../shared/bot-types'
import { botHomeName, botHomes } from '../../../shared/bots/bot-home-of'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import {
  conversationRecordReader,
  lineageLiveSession
} from '../../runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import type { BotShareDevices } from './bot-share-access'

/** After a share of `botId` changed (`before`: the bot as it was). Naming is metadata: a failure
 *  is logged and blocks nothing. */
export async function refreshSharePersonNames(
  runtime: {
    bots: { list: () => readonly Bot[] }
    botShareDevices: Pick<BotShareDevices, 'syncBotShareDeviceNames'> | null | undefined
    refreshStructuredConversationTabTitle: (workspaceId: string, sessionId: string) => void
  },
  botId: string,
  before: Pick<Bot, 'shares'> | undefined
): Promise<void> {
  const bot = runtime.bots.list().find((entry) => entry.id === botId)
  const host = getStructuredAgentSessionHost()
  if (bot && host) {
    const records = conversationRecordReader(host.deps.store)
    for (const home of botHomes(bot)) {
      if (home.of === 'owner' || botHomeName(bot, home.of) === botHomeName(before ?? {}, home.of)) {
        continue
      }
      const sessionId = lineageLiveSession(records, home.sessionId)?.sessionId ?? home.sessionId
      try {
        host.publishConversationName(sessionId)
        runtime.refreshStructuredConversationTabTitle(
          folderWorkspaceKey(bot.folderWorkspaceId),
          sessionId
        )
      } catch (error) {
        console.warn('[bots] a teammate’s Home title was not refreshed:', error)
      }
    }
  }
  await runtime.botShareDevices
    ?.syncBotShareDeviceNames()
    .catch((error: unknown) => console.warn('[bots] share device names not rewritten:', error))
}
