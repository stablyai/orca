// A bot's failing looks: which failure its owner hears of, and when Look around gives up.
import type { LookAroundRun } from './bot-look-around-state'

/** A bot's looks, or its tidy-ups: the same rules for each. */
type Runs = { runs: readonly LookAroundRun[] }

/** Failed looks in a row that turn Look around off. */
export const LOOK_FAILURES_TO_TURN_OFF = 10

/** The ended looks before `end` that failed, back to the last success, and whether one notified. */
function failureStreak(
  runs: readonly LookAroundRun[],
  end: number
): { failed: number; alerted: boolean } {
  let failed = 0
  let alerted = false
  for (const run of runs.slice(0, end).toReversed()) {
    // A run the host's sleep cut short is neither a failure nor a success.
    if (run.endedAt === undefined || run.asleep === true) {
      continue
    }
    if (run.error === undefined) {
      break
    }
    failed += 1
    alerted ||= run.alerted === true
  }
  return { failed, alerted }
}

export function failedLooksInARow(state: Runs): number {
  return failureStreak(state.runs, state.runs.length).failed
}

/** A failed look is no news once its streak notified, unless it is the failure that turns
 *  Look around off: the owner hears of the first failure and of the last. */
export function lookFailureIsQuiet(state: Runs, sessionId: string): boolean {
  const index = state.runs.findIndex((run) => run.sessionId === sessionId)
  if (index === -1) {
    return false
  }
  const streak = failureStreak(state.runs, index)
  return streak.alerted && streak.failed + 1 < LOOK_FAILURES_TO_TURN_OFF
}
