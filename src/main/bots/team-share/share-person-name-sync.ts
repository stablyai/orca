// A share's person name has one source, the share row. The copies written from it, the teammate's
// Home name (what every reader shows the owner) and each device row's name (for older builds),
// are rewritten together here whenever a share changes.
import type { Bot } from '../../../shared/bot-types'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { BotShareDevices } from './bot-share-access'
import { syncTeammateHomeNames } from '../bot-home-chat-name'
import { botHomeName, botHomes } from '../../../shared/bots/bot-home-of'

/** After a share of `botId` changed (`before`: the bot as it was). A Home whose name changed opens
 *  the chat host to be renamed, so no name is ever lost to a host not open yet. Naming is metadata:
 *  a failure is logged and blocks nothing. */
export async function syncSharePersonNames(
  runtime: {
    bots: { list: () => readonly Bot[] }
    botShareDevices: Pick<BotShareDevices, 'syncBotShareDeviceNames'> | null | undefined
    ensureStructuredAgentSessionHost: () => Promise<void>
  },
  botId: string,
  before: Pick<Bot, 'shares'> | undefined
): Promise<void> {
  const bot = runtime.bots.list().find((entry) => entry.id === botId)
  if (bot && teammateHomeRenamed(bot, before)) {
    await runtime
      .ensureStructuredAgentSessionHost()
      .catch((error: unknown) =>
        console.warn('[bots] chat host not opened to rename a Home:', error)
      )
    const host = getStructuredAgentSessionHost()
    if (host) {
      await syncTeammateHomeNames(host, bot, before)
    }
  }
  await runtime.botShareDevices
    ?.syncBotShareDeviceNames()
    .catch((error: unknown) => console.warn('[bots] share device names not rewritten:', error))
}

/** Whether a teammate's Home made so far goes by another name than it did `before`. */
function teammateHomeRenamed(bot: Bot, before: Pick<Bot, 'shares'> | undefined): boolean {
  return botHomes(bot).some(
    (home) =>
      home.of !== 'owner' && botHomeName(bot, home.of) !== botHomeName(before ?? {}, home.of)
  )
}
