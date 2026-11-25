// `bots.chats.reopen`: an agent brings one of a bot's closed chats back on purpose, with its history,
// so it takes mail again. Nothing reopens a chat on its own.
import { isBotAgent } from '../../../../shared/bot-types'
import { BOT_CHAT_ID_PREFIX } from '../../../../shared/bots/bot-chat-row'
import {
  formatOrcaSessionAddress,
  isOrcaSessionId
} from '../../../../shared/agent-session/identity/orca-session-address'
import { BotChatReopen } from '../../../../shared/rpc-contract/bot-chats-params'
import {
  lineageLiveSession,
  readAgentSessionRecordStore
} from '../../orchestration/addressing/session-lineage/structured-session-lineage'
import { runsCoordinatedBy } from '../../orchestration/db/bot-requests/bot-request-sender-pending'
import { showBotSessionTab } from '../../../bots/bot-session-tab-show'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod, InvalidArgumentError } from '../core'
import { namedOrCallerBot } from './bots-caller-bot'
import { readBotChats } from './bots-chats'

/** Brings a closed chat back as a tab in the bot's home, so it takes mail again; its history is kept. */
export const BOT_CHATS_REOPEN_METHOD = defineMethod({
  name: 'bots.chats.reopen',
  permission: 'workspace',
  params: BotChatReopen,
  handler: async (params, context) => {
    const { runtime } = context
    const { bot } = namedOrCallerBot(params, context)
    const id = params.chatId.startsWith(BOT_CHAT_ID_PREFIX)
      ? params.chatId.slice(BOT_CHAT_ID_PREFIX.length)
      : params.chatId
    const row = (await readBotChats(runtime, bot, null, true)).find((chat) => chat.id === id)
    if (!row) {
      throw new InvalidArgumentError(
        `${bot.name} has no chat ${params.chatId}. orca bot chats --all lists its chats.`
      )
    }
    if (!row.closed) {
      return { reopened: false, chatId: row.id }
    }
    // A chat closed here comes back; one running on another computer, or not checkable, doesn't.
    if (row.reason !== 'ended') {
      throw new InvalidArgumentError(
        `That chat can't be reopened from here: ${row.reason === 'other-host' ? 'it runs on another computer' : 'Orca can’t check it right now'}.`
      )
    }
    const store = readAgentSessionRecordStore()
    const live = (store && lineageLiveSession(store, row.id)) || null
    // The chat keeps the agent it ran on, even after the bot moved to another.
    const provider = live?.provider
    const agent = provider && isBotAgent(provider) ? provider : bot.agent
    await showBotSessionTab(runtime, { ...bot, agent }, live?.sessionId ?? row.id)
    const after = (await readBotChats(runtime, bot, null, true)).find((chat) => chat.id === row.id)
    if (!after || after.closed) {
      throw new InvalidArgumentError('That chat could not be reopened, so it still takes no mail.')
    }
    const sessionIds = [...new Set([row.id, live?.sessionId ?? row.id])]
    // A run's chat is released again once its next conversation is over.
    runtime.botRunChatCloser?.reopened(bot, row.id)
    // Mail that waited while it was closed goes in now, as it would have to an open chat.
    deliverWaitingMail(runtime, sessionIds)
    return { reopened: true, chatId: row.id }
  }
})

/** Wakes the chat's mailbox and its Runs' so mail stored while it was closed is handed over now. */
function deliverWaitingMail(
  runtime: Pick<OrcaRuntimeService, 'notifyMessageArrived' | 'getOrchestrationDb'>,
  sessionIds: readonly string[]
): void {
  for (const id of sessionIds) {
    if (isOrcaSessionId(id)) {
      runtime.notifyMessageArrived(formatOrcaSessionAddress(id))
    }
  }
  for (const run of runsCoordinatedBy(runtime.getOrchestrationDb(), sessionIds)) {
    runtime.notifyMessageArrived(`run:${run}`)
  }
}
