import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { settleBotRequestTurn } from '../runtime/rpc/methods/orchestration/messaging/bot-request-outcome'
import { botGroupRoomOfSession, markBotGroupRoomUnread } from './bot-group-runtime'
import type { BotGroupRoomOfSession } from '../runtime/agent-session/lifecycle/structured-agent-session-mobile-attention'
import { noteBotGroupMemberReply } from './bot-group-latest'
import { type BotRecentChatsSection, readBotRecentChats } from './bot-recent-chats'
import { BOT_WORK_NOTE_TIMEOUT_MS } from './bot-work-record'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import type { AgentJournalMessageItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { Bot } from '../../shared/bot-types'
import type { BotChatRow } from '../../shared/bots/bot-chat-row'
import { readBotChats } from '../runtime/rpc/methods/bots-chats'
import { sendBotItemMail } from '../runtime/rpc/methods/bots-items-mail'
import type { BotItemMail } from './bot-items-schema'
import { createBotUnansweredQuestionNote } from './bot-unanswered-question-note'
import { requireStructuredHost } from './bot-chat-session'

/** A bot session's turn ended: settle the request it answered, and raise its group room. */
export function botTurnEnded(runtime: OrcaRuntimeService, sessionId: string): void {
  markBotGroupRoomUnread(runtime, sessionId)
  void noteBotGroupMemberReply(runtime, sessionId).catch((error: unknown) =>
    console.warn('[bot-groups] could not note a reply for the sidebar', error)
  )
  void settleBotRequestTurn(runtime, sessionId).catch((error: unknown) =>
    console.warn('[bots] could not settle a bot request turn', error)
  )
}

/** Bot session work the runtime base needs but only the whole runtime can do. */
export type BotSessionHooks = {
  turnEnded: (sessionId: string) => void
  groupRoomOf: (sessionId: string) => BotGroupRoomOfSession | null
  /** What a bot's other chats did lately, for a turn of one of its chats. */
  recentChats: (
    botId: string,
    sessionId: string,
    message: AgentJournalMessageItem
  ) => Promise<BotRecentChatsSection | null>
  /** The every-fifth-turn note on questions the owner left unanswered, for a turn starting now. */
  unansweredQuestionNote: (sessionId: string) => Promise<string | null>
  /** A bot's chats on this host, closed ones too, each with whether it takes mail. */
  chatsOf: (bot: Bot, sessionId: string) => Promise<BotChatRow[]>
  /** Stores an owner item change's mail for its chat; true once nothing is owed. */
  sendItemMail: (mail: BotItemMail) => Promise<boolean>
}

export function botSessionHooks(runtime: OrcaRuntimeService): BotSessionHooks {
  const unansweredQuestionNote = createBotUnansweredQuestionNote({
    getOrchestrationDb: () => runtime.getOrchestrationDb(),
    listAutomationRuns: () => runtime.listAutomationRuns(),
    showAutomation: (id) => runtime.showAutomation(id),
    lookAround: {
      botOfLook: (sessionId) => runtime.lookAround.botOfLook(sessionId),
      botOfTidyUp: (sessionId) => runtime.lookAround.botOfTidyUp(sessionId)
    },
    endedTurns: async (sessionId) =>
      (await (await requireStructuredHost(runtime)).journalReads(sessionId)).endedTurnCount()
  })
  return {
    turnEnded: (sessionId) => botTurnEnded(runtime, sessionId),
    groupRoomOf: (sessionId) => botGroupRoomOfSession(runtime, sessionId),
    // A stalled read never holds a message back: past the bound, this turn goes without it.
    recentChats: (botId, sessionId, message) =>
      withTimeout(
        readBotRecentChats(runtime, botId, sessionId, message),
        BOT_WORK_NOTE_TIMEOUT_MS,
        null
      ),
    // Like the recent chats: a failed or stalled read means no note this turn, never a held message.
    unansweredQuestionNote: (sessionId) =>
      withTimeout(
        unansweredQuestionNote(sessionId).catch(() => null),
        BOT_WORK_NOTE_TIMEOUT_MS,
        null
      ),
    chatsOf: (bot, sessionId) => readBotChats(runtime, bot, sessionId, true),
    sendItemMail: (mail) => sendBotItemMail(runtime, mail)
  }
}
