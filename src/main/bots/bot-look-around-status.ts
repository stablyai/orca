// What clients say about a bot's looks beyond its suggestions: when the next one is and why, which
// slot didn't run, whether the last ran late, and failures the owner should hear about.
import type { BotLookAround, UpNextState } from '../../shared/bots/bot-look-around'
import { failedLooksInARow, LOOK_FAILURES_TO_TURN_OFF } from './bot-look-around-failures'
import { decidedBefore, lookAroundDecision, recentSlotsByTime } from './bot-look-around-schedule'
import { LOOK_AROUND_HOST_CLOCK, lookAroundZone } from '../../shared/bots/bot-look-around-times'
import type { BotLookState } from './bot-look-around-state'

/** Failed looks in a row after which the owner is asked to step in. */
export const LOOK_FAILURES_NEED_YOU = 3
/** How many of a listed time's latest scheduled slots are weighed: weekends a weekdays-only
 *  schedule skips don't count, so a weekday streak still shows on Monday. */
export const LOOK_REPEAT_SLOTS = 3
/** A slot missed while the machine slept runs later the same day, until the next slot; clients
 *  word missed looks by it. */
export const LOOK_AROUND_CATCH_UP = true

export function hostTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** The listed time whose latest LOOK_REPEAT_SLOTS decided slots failed or went by unrun most,
 *  when at least twice: a later success the same day doesn't hide an 8:00 AM look that keeps failing
 *  or missing. Times the owner removed no longer count; their old receipts are ignored. */
function repeatTrouble(
  setting: BotLookAround,
  state: BotLookState,
  now: number
): UpNextState['repeatTrouble'] {
  if (state.armedAt === undefined) {
    return undefined
  }
  const failed = new Set(
    state.runs.flatMap((run) =>
      run.scheduledFor !== undefined && run.error !== undefined ? [run.scheduledFor] : []
    )
  )
  const missed = new Set(state.missedSlots ?? [])
  let worst: NonNullable<UpNextState['repeatTrouble']> | undefined
  // Only decided slots count; one still catching up isn't trouble yet.
  for (const slots of recentSlotsByTime(
    setting,
    decidedBefore(setting, now) - 1,
    LOOK_REPEAT_SLOTS
  ).values()) {
    const counted = slots.filter((slot) => slot >= state.armedAt!)
    const entry = {
      scheduledFor: counted.find((slot) => failed.has(slot) || missed.has(slot)) ?? 0,
      failed: counted.filter((slot) => failed.has(slot)).length,
      missed: counted.filter((slot) => missed.has(slot) && !failed.has(slot)).length,
      of: counted.length
    }
    const total = entry.failed + entry.missed
    if (total >= 2 && (!worst || total > worst.failed + worst.missed)) {
      worst = entry
    }
  }
  return worst
}

/** The schedule's part of Up next's state: the runner's own decision, so "Next look" names the
 *  slot it will start. `settled` is false while the machine is asleep or just woke; a paused bot
 *  has no look due. */
export function lookAroundScheduleState(
  setting: BotLookAround,
  state: BotLookState,
  now: number,
  options: { hostZone?: string; settled?: boolean; paused?: boolean } = {}
): Partial<UpNextState> {
  const hostZone = options.hostZone ?? hostTimeZone()
  const timeZone = lookAroundZone(setting) ?? hostZone
  const { next, missedAt } = lookAroundDecision(setting, state, now)
  const last = state.runs.toReversed().find((run) => run.endedAt !== undefined)
  const failedInARow = failedLooksInARow(state)
  const repeat = repeatTrouble(setting, state, now)
  return {
    timeZone,
    hostTimeZone: hostZone,
    ...(setting.timezone &&
    setting.timezone !== LOOK_AROUND_HOST_CLOCK &&
    timeZone === hostZone &&
    !lookAroundZone(setting)
      ? { zoneUnreadable: true as const }
      : {}),
    ...(next ? { nextAt: next.at } : {}),
    ...(next?.due && !options.paused
      ? {
          dueNow: true as const,
          ...(next.until !== undefined ? { nextGraceEndsAt: next.until } : {}),
          ...(options.settled === false ? { nextHeld: true as const } : {})
        }
      : {}),
    ...(next?.skipped ? { nextSkipped: next.skipped } : {}),
    // Only a slot the runner saw go by while the bot was on, unpaused and unchanged.
    ...(missedAt !== undefined && state.missedSlots?.includes(missedAt) ? { missedAt } : {}),
    ...(last?.late && last.scheduledFor !== undefined ? { lastLateFor: last.scheduledFor } : {}),
    ...(failedInARow > 0 ? { failedInARow } : {}),
    ...(repeat ? { repeatTrouble: repeat } : {}),
    ...(LOOK_AROUND_CATCH_UP ? { catchUp: true as const } : {})
  }
}

/** For a bot whose owner should step in, how many looks went wrong: on, a few failed in a row or
 *  one slot failing or missed on most recent days; off, the failures that turned it off. Bots that
 *  need nothing are left out. Misses never turn Look around off. */
export function lookAroundNeedsYou(
  setting: BotLookAround,
  state: BotLookState,
  now: number
): number | undefined {
  const failed = failedLooksInARow(state)
  if (!setting.on) {
    return failed >= LOOK_FAILURES_TO_TURN_OFF ? failed : undefined
  }
  const trouble = repeatTrouble(setting, state, now)
  const worst = Math.max(failed, trouble ? trouble.failed + trouble.missed : 0)
  return worst >= LOOK_FAILURES_NEED_YOU ? worst : undefined
}
