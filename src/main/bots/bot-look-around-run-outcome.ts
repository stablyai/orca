import type { BotTurnEnd } from './bot-run-turn-watch'

/** A look still going after this long awake is stopped on its host and recorded as stopped. */
export const LOOK_RUN_LIMIT_MS = 10 * 60 * 1000

export const LOOK_FAILURES = {
  unfinished: "The last look didn't finish.",
  timedOut: `The last look was stopped after ${LOOK_RUN_LIMIT_MS / 60_000} min.`,
  interrupted: 'Orca stopped during the last look.',
  couldNotStart: "The last look couldn't start.",
  asleep: 'The last look was missed because this computer was asleep.'
} as const

export function lookFailureOf(ended: BotTurnEnd | 'timed_out'): string | undefined {
  if (ended === 'timed_out') {
    return LOOK_FAILURES.timedOut
  }
  return 'outcome' in ended && ended.outcome === 'success' ? undefined : LOOK_FAILURES.unfinished
}
