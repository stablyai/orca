// When a nightly memory tidy-up's failures turn it off, and which reach the owner: only runs since
// the owner last turned it on count, so an old streak never ends a new one.
import { botTidyUp } from '../../shared/bots/bot-tidy-up'
import type { Bot } from '../../shared/bot-types'
import {
  failedLooksInARow,
  LOOK_FAILURES_TO_TURN_OFF,
  lookFailureIsQuiet
} from './bot-look-around-failures'
import type { BotTidyUpState } from './bot-memory-tidy-up'

/** Its runs since the owner last turned it on: a streak of failures from before never counts. */
export function tidyUpRunsSinceOn(state: BotTidyUpState, bot: Pick<Bot, 'tidyUp'>): BotTidyUpState {
  const since = botTidyUp(bot).since ?? 0
  return { ...state, runs: state.runs.filter((run) => run.startedAt >= since) }
}

/** Whether Orca, not the owner, turned it off: the error it stopped on, else null. */
export function tidyUpTurnedOff(state: BotTidyUpState, bot: Pick<Bot, 'tidyUp'>): string | null {
  return !botTidyUp(bot).on &&
    failedLooksInARow(tidyUpRunsSinceOn(state, bot)) >= LOOK_FAILURES_TO_TURN_OFF
    ? (state.runs.at(-1)?.error ?? null)
    : null
}

/** A failed run the owner needn't hear of: its streak since Tidy-up was turned on already alerted. */
export function tidyUpFailureIsQuiet(
  state: BotTidyUpState,
  bot: Pick<Bot, 'tidyUp'>,
  sessionId: string
): boolean {
  return lookFailureIsQuiet(tidyUpRunsSinceOn(state, bot), sessionId)
}
