import { BotChat } from '../../../../shared/rpc-contract/bots-params'
import { botFirstKickoff } from '../../../../shared/bots/bot-import'
import { releaseReplacedHomes } from '../../../bots/bot-home-chat-name'
import { retryBotKickoff } from '../../../bots/bot-kickoff-retry'
import { requireStructuredHost, runtimeBotChats } from '../../../bots/bot-chat-session'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'
import { SHARE_BY_BOT } from '../../../../shared/bots/bot-share-rpc-methods'
import { botShareScopeOf } from '../../../bots/team-share/bot-share-chats'
import { callerHomeOf } from './bots-caller-home'

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
    share: SHARE_BY_BOT,
    params: BotChat,
    handler: async (params, context) => {
      const { runtime } = context
      runtime.bots.assertEnabled()
      const of = callerHomeOf(botShareScopeOf(context))
      const chats = runtimeBotChats(runtime)
      const current = () => runtime.bots.list().find((entry) => entry.id === params.botId)
      // Under the Home's lock, a Home replaced before replaced Homes were renamed is renamed too.
      const sessionId = await chats.withChat(params.botId, of, async (id) => {
        const opened = current()
        if (opened) {
          await releaseReplacedHomes(await requireStructuredHost(runtime), opened)
        }
        return id
      })
      // The bot's page opens this, at launch too: a kickoff that ended silent gets its one retry.
      const bot = current()
      if (bot && of === 'owner') {
        void retryBotKickoff(bot, {
          ...kickoffReads(runtime),
          send: (botId) => chats.sendToChat(botId, 'owner', botFirstKickoff(bot), 'bot-created')
        }).catch((error: unknown) => console.warn('[bots] first-run kickoff retry failed:', error))
      }
      return { sessionId }
    }
  }),
  defineMethod({
    name: 'bots.kickoff.retry',
    permission: 'workspace',
    share: 'not-shared',
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
          send: (botId) => chats.sendToChat(botId, 'owner', botFirstKickoff(bot), 'bot-created')
        },
        true
      )
      return { retried }
    }
  })
]
