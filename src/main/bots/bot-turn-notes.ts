// The notes Orca adds to a bot chat's turns, each scoped by whom the chat is for (botTurnScope): the
// owner's live work, other chats and questions go only where the owner may hear them, and a
// teammate's turn is told who is asking.
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import {
  type BotActiveWorkSection,
  botIdleItemsNote,
  type BotTurnNoteRead,
  joinedTurnSections,
  type TurnSectionsMemo
} from './bot-active-work'
import type { BotRecentChatsSection } from './bot-recent-chats'
import { type BotTurnAudience, botTurnScope } from './bot-turn-audience'
import { BOT_WORK_NOTE_TIMEOUT_MS } from './bot-work-record'
import {
  botNeedsYouInChatNote,
  createBotUnansweredQuestionNote
} from './bot-unanswered-question-note'

export type BotTurnNoteSources = {
  audience: (sessionId: string) => BotTurnAudience
  recentChats: (botId: string, sessionId: string) => Promise<BotRecentChatsSection | null>
  activeWork: (botId: string) => Promise<BotActiveWorkSection>
  /** How many of the chat's turns have ended; rejects when the journal can't say. */
  endedTurns: (sessionId: string) => Promise<number>
}

export type BotTurnNotes = {
  /** What the bot's other chats did lately, with its live work, resent when either changes. */
  recentChats: (botId: string, sessionId: string) => Promise<BotRecentChatsSection | null>
  /** Who is asking, when it isn't the owner; the every-fifth-turn note on questions the owner left
   *  unanswered; and the notes on an owner chat's own Needs you items and on In progress items
   *  nothing runs for (each once per chat until it changes). */
  turnNote: BotTurnNoteRead
}

export function createBotTurnNotes(sources: BotTurnNoteSources): BotTurnNotes {
  const unansweredQuestionNote = createBotUnansweredQuestionNote(sources.endedTurns)
  // A slow or failed read keeps what the chat last got (undefined).
  const activeWorkSlot = (botId: string): Promise<BotActiveWorkSection | undefined> =>
    withTimeout<BotActiveWorkSection | undefined>(
      sources.activeWork(botId),
      BOT_WORK_NOTE_TIMEOUT_MS,
      undefined
    )
  const sections: TurnSectionsMemo = new Map()
  const idleSaid = new Map<string, Map<number, string>>()
  const needsYouSaid = new Map<string, string>()
  return {
    // A stalled read never holds a message back: past the bound, this turn goes without it.
    recentChats: async (botId, sessionId) => {
      if (!botTurnScope(sources.audience(sessionId)).ownerWork) {
        return null
      }
      return joinedTurnSections(
        sections,
        sessionId,
        await Promise.all([
          // A slow read drops the recent chats (null).
          withTimeout(sources.recentChats(botId, sessionId), BOT_WORK_NOTE_TIMEOUT_MS, null),
          activeWorkSlot(botId)
        ])
      )
    },
    // Like the recent chats: a failed or stalled read means no note this turn, never a held message.
    turnNote: async (sessionId, botId) => {
      const scope = botTurnScope(sources.audience(sessionId))
      const [unanswered, work] = await Promise.all([
        scope.ownerAsks
          ? withTimeout(
              unansweredQuestionNote(sessionId).catch(() => null),
              BOT_WORK_NOTE_TIMEOUT_MS,
              null
            )
          : null,
        scope.ownerWork ? activeWorkSlot(botId) : undefined
      ])
      const idle = work?.idle ? botIdleItemsNote(idleSaid, sessionId, work.idle) : null
      const needsYou =
        work?.needsYou && scope.ownerAsks
          ? botNeedsYouInChatNote(needsYouSaid, sessionId, work.needsYou)
          : null
      const text = [unanswered, needsYou?.text, idle?.text, scope.asker]
        .filter(Boolean)
        .join('\n\n')
      return text
        ? {
            text,
            given: () => {
              needsYou?.given()
              idle?.given()
            }
          }
        : null
    }
  }
}
