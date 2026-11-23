// Every few turns of a chat acting for the bot's owner: put a question they left unanswered on an item.
// The turn number is the chat's ended turns as its journal holds them, read on the journal's reader.
import { isOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address'
import { actsForOwner } from '../../shared/bots/bot-acts-for'
import { canonicalOrcaSessionId } from '../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import type { BotLookAroundStore } from './bot-look-around-store'
import {
  readBotConversationActsFor,
  type BotConversationActsForSources
} from './bot-conversation-acts-for'
import { BOT_ORCA_CLI } from './bot-preamble'

// From transcripts: 91% of the owner's replies come within 2 other turns of a question.
export const UNANSWERED_QUESTION_NOTE_EVERY_TURNS = 5

export const BOT_UNANSWERED_QUESTION_NOTE = `[Orca: if you asked your owner something in this chat that they've clearly left unanswered and that still matters, put it on an item as Needs you (${BOT_ORCA_CLI} bot item set <n> --status needs-you --comment "<context>" --ask "<question>", adding --option "..." per choice when it has choices), or add an item for it. Skip anything already on an item, and items your owner snoozed.]`

export type BotUnansweredQuestionSources = BotConversationActsForSources & {
  lookAround: Pick<BotLookAroundStore, 'botOfLook' | 'botOfTidyUp'>
  /** How many of the chat's turns have ended; rejects when the journal can't say. */
  endedTurns: (sessionId: string) => Promise<number>
}

/** The note for the turn starting now in one of a host's chats, when it is an owner chat's every-fifth. */
export function createBotUnansweredQuestionNote(
  sources: BotUnansweredQuestionSources
): (sessionId: string) => Promise<string | null> {
  // A chat's acts-for is written once and never changes, so each chat reads it once.
  const ownerChats = new Map<string, boolean>()
  const isOwnerChat = (sessionId: string): boolean => {
    const known = ownerChats.get(sessionId)
    if (known !== undefined) {
      return known
    }
    const root = isOrcaSessionId(sessionId) ? canonicalOrcaSessionId(sessionId) : sessionId
    const recorded = readBotConversationActsFor(sources, root)
    if (!recorded) {
      // Not recorded yet: a later turn reads it again.
      return false
    }
    const owner = actsForOwner(recorded.actsFor)
    ownerChats.set(sessionId, owner)
    return owner
  }
  return async (sessionId) => {
    if (
      sources.lookAround.botOfLook(sessionId) !== null ||
      sources.lookAround.botOfTidyUp(sessionId) !== null ||
      !isOwnerChat(sessionId)
    ) {
      return null
    }
    const ended = await sources.endedTurns(sessionId)
    return (ended + 1) % UNANSWERED_QUESTION_NOTE_EVERY_TURNS === 0
      ? BOT_UNANSWERED_QUESTION_NOTE
      : null
  }
}
