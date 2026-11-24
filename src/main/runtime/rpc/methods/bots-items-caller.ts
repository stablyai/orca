// Who is calling `bots.items.*`: only a bot's own chat on this host writes, and the author is always
// that bot. Look around and Tidy-up runs resolve to their bot too, so they may read but never write.
import type { Bot } from '../../../../shared/bot-types'
import { isOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address'
import { isBotBackgroundRun } from '../../../bots/bot-background-run-records'
import { botOfCaller } from '../../../bots/bot-of-caller'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { BotItemError } from '../../../bots/bot-item-error'
import type { BotItemBotActor } from '../../../bots/bot-items-input'
import type { BotItemSource } from '../../../bots/bot-items-schema'
import { createCanonicalOrcaSessionResolver } from '../../orchestration/addressing/session-lineage/canonical-orca-session-id'
import { readAgentSessionRecordStore } from '../../orchestration/addressing/session-lineage/structured-session-lineage'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { InvalidArgumentError, type RpcContext } from '../core'
import { isBotOwnChat } from '../../../bots/bot-own-chat'

export type BotItemWriter = {
  bot: Bot
  actor: BotItemBotActor
  /** The calling session itself (a /clear moves it on; the chat id is its lineage's root). */
  sessionId: string
  source: BotItemSource
}

type CallerRuntime = Pick<
  OrcaRuntimeService,
  'bots' | 'lookAround' | 'botItems' | 'getOrchestrationDb'
>

const ONLY_BOT_CHATS =
  "Only a bot writes items, from one of its own chats. Run this from the bot's chat; your owner changes items in Orca."
const BACKGROUND_READ_ONLY =
  'Look around and Tidy-up runs read items but never change them. Suggest the change instead.'

/** The session a caller claims, honored only from this host's own CLI. */
function claimedSession(
  callerSessionId: string | undefined,
  context: Pick<RpcContext, 'pairedDeviceId'>
) {
  return context.pairedDeviceId === undefined ? callerSessionId : undefined
}

/** The bot whose items a read is for: `--bot` names one, else the calling chat's or run's bot. */
export function itemsReader(
  params: { botId?: string; callerSessionId?: string },
  context: Pick<RpcContext, 'runtime' | 'pairedDeviceId'>
): Bot {
  const { runtime } = context
  if (params.botId) {
    const named = runtime.bots.list().find((bot) => bot.id === params.botId)
    if (!named) {
      throw new InvalidArgumentError('bot_not_found')
    }
    return named
  }
  const bot = botOfCaller(runtime, params.callerSessionId, context.pairedDeviceId)
  if (!bot) {
    throw new InvalidArgumentError('Name the bot with --bot, or run this from the bot’s chat.')
  }
  return bot
}

/** The writing bot and chat; refused for anything but a bot's own chat on this host. */
export function itemsWriter(
  callerSessionId: string | undefined,
  context: Pick<RpcContext, 'runtime' | 'pairedDeviceId'>
): BotItemWriter {
  const runtime: CallerRuntime = context.runtime
  const sessionId = claimedSession(callerSessionId, context)
  if (!sessionId || !runtime.bots.enabled()) {
    throw new BotItemError('invalid_argument', ONLY_BOT_CHATS)
  }
  const store = readAgentSessionRecordStore()
  const record = store?.getRecord(sessionId) ?? null
  const background =
    runtime.lookAround.botOfLook(sessionId) !== null ||
    runtime.lookAround.botOfTidyUp(sessionId) !== null ||
    (record !== null && isBotBackgroundRun(runtime.lookAround, record))
  if (background) {
    throw new BotItemError('invalid_argument', BACKGROUND_READ_ONLY)
  }
  const bot = botOfSession(runtime.bots, sessionId)
  if (!bot || !store || !record || !isOrcaSessionId(sessionId)) {
    throw new BotItemError('invalid_argument', ONLY_BOT_CHATS)
  }
  const rootOf = createCanonicalOrcaSessionResolver(store)
  const root = (id: string) => (isOrcaSessionId(id) ? rootOf(id) : id)
  if (!isBotOwnChat(record, runtime.getOrchestrationDb(), store)) {
    throw new BotItemError('invalid_argument', ONLY_BOT_CHATS)
  }
  const chatId = root(sessionId)
  return {
    bot,
    actor: { kind: 'bot', botId: bot.id, chatId },
    sessionId,
    // Read only by writes that make an item or ask on one: it lists the bot's thread chats and runs.
    get source() {
      return runtime.botItems.chatSource(bot, chatId, root, record?.conversationName ?? null)
    }
  }
}
