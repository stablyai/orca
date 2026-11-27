// The notes Orca adds to a bot chat's turns, each scoped by whom the chat is for (botTurnScope): a
// turn lists only its own person's items, the owner's other chats, workers and questions go only
// where the owner may hear them, and a teammate's turn is told who is asking.
import { withTimeout } from '../../shared/concurrency/promise-timeout-fallback'
import {
  type BotActiveWorkSection,
  botIdleItemsNote,
  type BotTurnNoteRead,
  joinedTurnSections,
  type TurnSectionsMemo
} from './bot-active-work'
import type { BotActiveWorkScope } from './bot-active-work-read'
import { type BotItemAccess, botItemPeopleOfAudience, botItemsOfPeople } from './bot-item-access'
import type { BotRecentChatsSection } from './bot-recent-chats'
import { type BotTurnAudience, botTurnAskerLine, botTurnScope } from './bot-turn-audience'
import { botMessageTypist } from './bot-typed-in-orca'
import type { Bot } from '../../shared/bot-types'
import { BOT_WORK_NOTE_TIMEOUT_MS } from './bot-work-record'
import {
  botNeedsYouInChatNote,
  createBotUnansweredQuestionNote
} from './bot-unanswered-question-note'

export type BotTurnNoteSources = {
  audience: (sessionId: string) => BotTurnAudience
  recentChats: (botId: string, sessionId: string) => Promise<BotRecentChatsSection | null>
  activeWork: (botId: string, scope: BotActiveWorkScope) => Promise<BotActiveWorkSection>
  /** How many of the chat's turns have ended; rejects when the journal can't say. */
  endedTurns: (sessionId: string) => Promise<number>
  /** The agent, for who typed a turn's message (`botMessageTypist`). */
  bot: (botId: string) => Pick<Bot, 'shares'> | null
}

export type BotTurnNotes = {
  /** What the bot's other chats did lately (the owner's chats only), with the live work of the
   *  turn's person, resent when either changes. */
  recentChats: (botId: string, sessionId: string) => Promise<BotRecentChatsSection | null>
  /** Who is asking, when it isn't the owner; the every-fifth-turn note on questions the owner left
   *  unanswered; and the notes on an owner chat's own Needs you items and on In progress items
   *  nothing runs for (each once per chat until it changes). */
  turnNote: BotTurnNoteRead
}

/** Whose items a turn lists: only its own person's, the owner's turns included (his choice). */
const turnItems = (audience: BotTurnAudience): BotItemAccess =>
  botItemsOfPeople(botItemPeopleOfAudience(audience))

export function createBotTurnNotes(sources: BotTurnNoteSources): BotTurnNotes {
  const unansweredQuestionNote = createBotUnansweredQuestionNote(sources.endedTurns)
  // A slow or failed read keeps what the chat last got (undefined).
  const activeWorkSlot = (
    botId: string,
    audience: BotTurnAudience
  ): Promise<BotActiveWorkSection | undefined> =>
    withTimeout<BotActiveWorkSection | undefined>(
      sources.activeWork(botId, {
        items: turnItems(audience),
        workers: botTurnScope(audience).ownerWork
      }),
      BOT_WORK_NOTE_TIMEOUT_MS,
      undefined
    )
  const sections: TurnSectionsMemo = new Map()
  const idleSaid = new Map<string, Map<number, string>>()
  const needsYouSaid = new Map<string, string>()
  return {
    // A stalled read never holds a message back: past the bound, this turn goes without it.
    recentChats: async (botId, sessionId) => {
      const audience = sources.audience(sessionId)
      return joinedTurnSections(
        sections,
        sessionId,
        await Promise.all([
          // A slow read drops the recent chats (null).
          botTurnScope(audience).ownerWork
            ? withTimeout(sources.recentChats(botId, sessionId), BOT_WORK_NOTE_TIMEOUT_MS, null)
            : null,
          activeWorkSlot(botId, audience)
        ])
      )
    },
    // Like the recent chats: a failed or stalled read means no note this turn, never a held message.
    turnNote: async (sessionId, botId, message) => {
      const audience = sources.audience(sessionId)
      const scope = botTurnScope(audience)
      const [unanswered, work] = await Promise.all([
        scope.ownerAsks
          ? withTimeout(
              unansweredQuestionNote(sessionId).catch(() => null),
              BOT_WORK_NOTE_TIMEOUT_MS,
              null
            )
          : null,
        activeWorkSlot(botId, audience)
      ])
      const idle = work?.idle ? botIdleItemsNote(idleSaid, sessionId, work.idle) : null
      const needsYou =
        work?.needsYou && scope.ownerAsks
          ? botNeedsYouInChatNote(needsYouSaid, sessionId, work.needsYou)
          : null
      // Who asks: this message's typist when that isn't whom the chat is for, else the chat's person.
      const asker = botTurnAskerLine(
        audience,
        botMessageTypist(sources.bot(botId), message?.typedBy)
      )
      const text = [unanswered, needsYou?.text, idle?.text, asker].filter(Boolean).join('\n\n')
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
