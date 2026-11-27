// A share's person name has one source, the share row. The copies written from it, the teammate's
// Home name (what every reader shows the owner) and each device row's name (for older builds),
// are rewritten together here whenever a share changes.
import type { Bot } from '../../../shared/bot-types'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { BotShareDevices } from './bot-share-access'
import { syncTeammateHomeNames } from '../bot-home-chat-name'

/** After a share of `botId` changed (`before`: the bot as it was). Naming is metadata: a failure
 *  is logged and blocks nothing; an unopened chat host is synced when the bot's Chat opens. */
export async function syncSharePersonNames(
  runtime: {
    bots: { list: () => readonly Bot[] }
    botShareDevices: Pick<BotShareDevices, 'syncBotShareDeviceNames'> | null | undefined
  },
  botId: string,
  before: Pick<Bot, 'shares'> | undefined
): Promise<void> {
  const bot = runtime.bots.list().find((entry) => entry.id === botId)
  const host = getStructuredAgentSessionHost()
  if (bot && host) {
    await syncTeammateHomeNames(host, bot, before)
  }
  await runtime.botShareDevices
    ?.syncBotShareDeviceNames()
    .catch((error: unknown) => console.warn('[bots] share device names not rewritten:', error))
}
