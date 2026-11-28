import { BotChat, BotChatSwitchVendor } from '../../../../shared/rpc-contract/bots-params'
import { botFirstKickoff } from '../../../../shared/bots/bot-import'
import { releaseReplacedHomes } from '../../../bots/bot-home-chat-name'
import { retryBotKickoff } from '../../../bots/bot-kickoff-retry'
import { requireStructuredHost, runtimeBotChats } from '../../../bots/bot-chat-session'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { runCrossVendorHandoff } from '../../../native-chat/agent-session-wire/cross-vendor/cross-vendor-handoff'
import { getCrossVendorHandoffSeeds } from '../../../native-chat/agent-session-wire/cross-vendor/cross-vendor-handoff-seeds'
import { linkBotOwnSkills } from '../../../bots/bot-own-skills'
import { botHomeFolder } from '../../../bots/bot-home'
import { ownerOnly } from './bots-caller-gates'

/** A kickoff retry reads each send's fingerprint first, and the chat from its start only once that
 *  shows Orca's kickoff (and, on Try again, the owner's sends to check none reached the agent).
 *  Naming every send keeps a refused one that left no row. */
function kickoffReads(runtime: RpcContext['runtime']) {
  const reads = async (id: string) => (await requireStructuredHost(runtime)).journalReads(id)
  return {
    fingerprints: async (id: string) => (await reads(id)).sendFingerprints(),
    snapshot: async (id: string, sends: readonly string[]) =>
      (
        await (
          await reads(id)
        ).operationWindow({
          afterSequence: 0,
          operationIds: sends,
          withoutToolOutput: true
        })
      ).snapshot
  }
}

export const BOT_KICKOFF_METHODS = [
  defineMethod({
    name: 'bots.chat.open',
    permission: 'workspace',
    params: BotChat,
    handler: async (params, { runtime }) => {
      runtime.bots.assertEnabled()
      const chats = runtimeBotChats(runtime)
      const current = () => runtime.bots.list().find((entry) => entry.id === params.botId)
      // Under the Chat's lock, a Home replaced before replaced Homes were renamed is renamed too.
      const sessionId = await chats.withChat(params.botId, async (id) => {
        const opened = current()
        if (opened) {
          await releaseReplacedHomes(await requireStructuredHost(runtime), opened)
        }
        return id
      })
      // The bot's page opens this, at launch too: a kickoff that ended silent gets its one retry.
      const bot = current()
      if (bot) {
        void retryBotKickoff(bot, {
          ...kickoffReads(runtime),
          send: (botId) => chats.sendToChat(botId, botFirstKickoff(bot), 'bot-created')
        }).catch((error: unknown) => console.warn('[bots] first-run kickoff retry failed:', error))
      }
      return { sessionId }
    }
  }),
  defineMethod({
    name: 'bots.chat.switchVendor',
    permission: 'workspace',
    params: BotChatSwitchVendor,
    handler: async ({ botId, sourceSessionId, setup }, context) => {
      ownerOnly(context, "Only the owner can switch a bot's agent.")
      const { runtime } = context
      runtime.bots.assertEnabled()
      const host = await requireStructuredHost(runtime)
      const seeds = getCrossVendorHandoffSeeds()
      if (!seeds) {
        throw new Error('structured_agent_session_unsupported')
      }
      const sessionId = await runtimeBotChats(runtime).switchVendor(
        botId,
        sourceSessionId,
        setup,
        (sessionId) => runCrossVendorHandoff(host, seeds, { sessionId, sourceSessionId })
      )
      const bot = runtime.bots.list().find((entry) => entry.id === botId)
      if (bot) {
        void linkBotOwnSkills(botHomeFolder(bot)).catch(() => {})
      }
      return { sessionId }
    }
  }),
  defineMethod({
    name: 'bots.kickoff.retry',
    permission: 'workspace',
    params: BotChat,
    // A new bot's Try again: its first turn ended without a word.
    handler: async (params, { runtime }) => {
      runtime.bots.assertEnabled()
      const bot = runtime.bots.list().find((entry) => entry.id === params.botId)
      if (!bot) {
        throw new InvalidArgumentError('bot_not_found')
      }
      const chats = runtimeBotChats(runtime)
      const retried = await retryBotKickoff(
        bot,
        {
          ...kickoffReads(runtime),
          send: (botId) => chats.sendToChat(botId, botFirstKickoff(bot), 'bot-created')
        },
        true
      )
      return { retried }
    }
  })
]
