// Which of a bot's conversations are its own background runs (Look around, Tidy-up), never chats.
import type { BotLookAroundStore } from './bot-look-around-store'
import { LOOK_AROUND_PROMPT_OPENING } from './bot-look-around-prompt'
import { TIDY_UP_PROMPT_OPENING } from './bot-memory-tidy-up'

export type BotBackgroundRuns = Pick<BotLookAroundStore, 'botOfLook' | 'botOfTidyUp'>

type RunRecord = {
  sessionId: string
  conversationName?: string
  conversationNameSource?: 'user'
  lastTurn?: { prompt?: string }
}

/** A run the store knows; or a run from before the store kept every run's session, known by the
 *  name Orca gave it and the prompt it opens with. */
export function isBotBackgroundRun(runs: BotBackgroundRuns, record: RunRecord): boolean {
  if (runs.botOfLook(record.sessionId) !== null || runs.botOfTidyUp(record.sessionId) !== null) {
    return true
  }
  if (record.conversationNameSource === 'user') {
    return false
  }
  const prompt = record.lastTurn?.prompt ?? ''
  return (
    (record.conversationName === 'Look around' && prompt.includes(LOOK_AROUND_PROMPT_OPENING)) ||
    (record.conversationName === 'Tidy-up' && prompt.includes(TIDY_UP_PROMPT_OPENING))
  )
}
