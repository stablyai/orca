import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  settleBotRequestFailure,
  settleBotRequestTurn
} from '../runtime/rpc/methods/orchestration/messaging/bot-request-outcome'
import { botGroupRoomOfSession, markBotGroupRoomUnread } from './bot-group-runtime'
import type { BotGroupRoomOfSession } from '../runtime/agent-session/lifecycle/structured-agent-session-mobile-attention'
import { noteBotGroupMemberReply } from './bot-group-latest'
import { type BotRecentChatsSection, readBotRecentChats } from './bot-recent-chats'
import {
  type BotActiveWorkSection,
  joinedTurnSections,
  type TurnSectionsMemo
} from './bot-active-work'
import { readBotActiveWork } from './bot-active-work-read'
import { BOT_WORK_NOTE_TIMEOUT_MS } from './bot-work-record'
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import type { Bot } from '../../shared/bot-types'
import type { BotChatRow } from '../../shared/bots/bot-chat-row'
import { readBotChats } from '../runtime/rpc/methods/bots-chats'
import { sendBotItemMail } from '../runtime/rpc/methods/bots-items-mail'
import type { BotItemMail } from './bot-items-schema'
import { createBotUnansweredQuestionNote } from './bot-unanswered-question-note'
import { requireStructuredHost } from './bot-chat-session'
import type { TurnEndedVerdict } from '../native-chat/agent-session-wire/structured-agent-session-turn-context'
import type { StructuredAgentSessionRequestFailure } from '../native-chat/agent-session-wire/observations/structured-agent-session-request-failures'

/** A bot session's turn ended: settle the request it answered, and raise its group room. */
export function botTurnEnded(
  runtime: OrcaRuntimeService,
  sessionId: string,
  turnId: string,
  ended?: TurnEndedVerdict
): void {
  markBotGroupRoomUnread(runtime, sessionId)
  void noteBotGroupMemberReply(runtime, sessionId, turnId).catch((error: unknown) =>
    console.warn('[bot-groups] could not note a reply for the sidebar', error)
  )
  void settleBotRequestTurn(runtime, sessionId, turnId, ended).catch((error: unknown) =>
    console.warn('[bots] could not settle a bot request turn', error)
  )
}

/** Bot session work the runtime base needs but only the whole runtime can do. */
export type BotSessionHooks = {
  turnEnded: (sessionId: string, turnId: string, ended?: TurnEndedVerdict) => void
  /** A chat's request failed; only a bot's tells its senders why. */
  requestFailed: (failure: StructuredAgentSessionRequestFailure) => void
  groupRoomOf: (sessionId: string) => BotGroupRoomOfSession | null
  /** What a bot's other chats did lately, for a turn of one of its chats. */
  recentChats: (botId: string, sessionId: string) => Promise<BotRecentChatsSection | null>
  /** The every-fifth-turn note on questions the owner left unanswered, for a turn starting now. */
  unansweredQuestionNote: (sessionId: string) => Promise<string | null>
  /** A bot's chats on this host, closed ones too, each with whether it takes mail. */
  chatsOf: (bot: Bot, sessionId: string) => Promise<BotChatRow[]>
  /** Stores an owner item change's mail for its chat; true once nothing is owed. */
  sendItemMail: (mail: BotItemMail) => Promise<boolean>
}

/** The turn's live-work slot; a slow or failed read keeps what the chat last got (undefined). */
function activeWorkSlot(
  runtime: OrcaRuntimeService,
  botId: string
): Promise<BotActiveWorkSection | undefined> {
  return withTimeout<BotActiveWorkSection | undefined>(
    readBotActiveWork(runtime, botId),
    BOT_WORK_NOTE_TIMEOUT_MS,
    undefined
  )
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
  const sections: TurnSectionsMemo = new Map()
  return {
    turnEnded: (sessionId, turnId, ended) => botTurnEnded(runtime, sessionId, turnId, ended),
    requestFailed: (failure) =>
      void settleBotRequestFailure(runtime, failure).catch((error: unknown) =>
        console.warn('[bots] could not settle a failed bot request', error)
      ),
    groupRoomOf: (sessionId) => botGroupRoomOfSession(runtime, sessionId),
    // A stalled read never holds a message back: past the bound, this turn goes without it.
    // With the bot's live work, which rides the same resend-on-change key; a slow live-work read
    // keeps what the chat last got.
    recentChats: async (botId, sessionId) =>
      joinedTurnSections(
        sections,
        sessionId,
        await Promise.all([
          // A slow read drops the recent chats (null).
          withTimeout(
            readBotRecentChats(runtime, botId, sessionId),
            BOT_WORK_NOTE_TIMEOUT_MS,
            null
          ),
          activeWorkSlot(runtime, botId)
        ])
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
