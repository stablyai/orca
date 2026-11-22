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
    // A run the host's sleep or a usage limit cut short is neither a failure nor a success.
    if (run.endedAt === undefined || run.asleep === true || run.usageLimited) {
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

/** A usage limit with no known reset holds scheduled runs this long, then they try again. */
export const USAGE_LIMIT_UNKNOWN_RESET_HOLD_MS = 60 * 60 * 1000

/** The reset the last usage-limited run waits for; no scheduled run starts before it. Only a later
 *  run that finished lifts it: one that failed otherwise (e.g. never started) proves no recovery. */
export function usageLimitedUntil(runs: readonly LookAroundRun[]): number {
  const limited = runs.findLast(
    (run) =>
      run.endedAt !== undefined && (run.usageLimited !== undefined || run.error === undefined)
  )
  return limited?.usageLimited
    ? (limited.usageLimited.resetsAt ?? limited.endedAt! + USAGE_LIMIT_UNKNOWN_RESET_HOLD_MS)
    : 0
}

/** Whether a usage-limited look still finishes in its own chat, so its slot starts no other:
 *  its continue is running or scheduled, or the chat already moved past that limit. */
export function limitedLookContinuesInItsChat(chat: {
  running: boolean
  stillLimited: boolean
  continueScheduled: boolean
}): boolean {
  return chat.running || !chat.stillLimited || chat.continueScheduled
}

/** A usage limit is news once: a look it ends right after another it ended stays quiet. */
export function usageLimitAlreadyNoted(runs: readonly LookAroundRun[]): boolean {
  return runs.findLast((run) => run.endedAt !== undefined)?.usageLimited !== undefined
}

/** Whether a usage limit ending this run follows one that ended the run before it. */
export function usageLimitNotedBefore(runs: readonly LookAroundRun[], sessionId: string): boolean {
  const index = runs.findIndex((run) => run.sessionId === sessionId)
  return index !== -1 && usageLimitAlreadyNoted(runs.slice(0, index))
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
