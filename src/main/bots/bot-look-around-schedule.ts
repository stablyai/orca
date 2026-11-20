// When a bot's looks are: one decision the runner and every "Next look" share, from its Look around
// times read on the schedule's wall clock, starting one interval after its first conversation. A slot
// the host slept through is caught up until the next slot, the same day.
import { automationScheduleCalendar } from '../../shared/automations/scheduling/automation-schedule-calendar'
import type { BotLookAround } from '../../shared/bots/bot-look-around'
import {
  lookAroundIntervalMs,
  lookAroundTimes,
  lookAroundZone
} from '../../shared/bots/bot-look-around-times'
import {
  ASLEEP_RETRY_AFTER_MS,
  type BotLookState,
  type LookAroundRun
} from './bot-look-around-state'
import { missedRun } from './bot-background-run-history'
import { usageLimitedUntil } from './bot-look-around-failures'

/** A Look now started this soon before a slot may stand in for it (and after it, at least). */
export const LOOK_RECENT_MS = 60 * 60 * 1000
/** Far enough back and ahead to cross a long weekend for a weekdays-only schedule. */
const SCAN_DAYS = 8
const MINUTE_MS = 60_000
/** No clock skips more than two hours. */
const GAP_STEPS_MAX = 120

/** Each listed time once per schedule-local date: a time a spring-forward skips runs at the first
 *  instant after the gap (never on the date before, for a gap at midnight), and a time a fall-back
 *  repeats runs at its first occurrence. */
function slotsOnDay(setting: BotLookAround, day: number): number[] {
  const calendar = automationScheduleCalendar(lookAroundZone(setting))
  const weekday = calendar.fields(day).weekday
  if (setting.weekdaysOnly && (weekday === 0 || weekday === 6)) {
    return []
  }
  return lookAroundTimes(setting).map((time) => {
    const [hour = 0, minute = 0] = time.split(':').map(Number)
    let at = calendar.atTime(day, hour, minute)
    if (wallMinutes(calendar.fields(at)) !== hour * 60 + minute) {
      // In a gap the calendar moves the time forward by the gap; step back to where the gap ends,
      // which is no earlier than the date's own first instant.
      for (let step = 0; step < GAP_STEPS_MAX; step += 1) {
        const before = at - MINUTE_MS
        if (before < day || wallMinutes(calendar.fields(before)) <= hour * 60 + minute) {
          break
        }
        at = before
      }
    }
    return at
  })
}

function wallMinutes(wall: { hour: number; minute: number }): number {
  return wall.hour * 60 + wall.minute
}

/** Slots on the days from `from` stepping by `step`, nearest first. */
function* slotsFrom(
  setting: BotLookAround,
  from: number,
  step: 1 | -1,
  days = SCAN_DAYS
): Generator<number> {
  const calendar = automationScheduleCalendar(lookAroundZone(setting))
  let day = calendar.startOfDay(from)
  for (let index = 0; index <= days; index += 1) {
    const slots = slotsOnDay(setting, day).sort((a, b) => (step === 1 ? a - b : b - a))
    yield* slots
    day = calendar.addDays(day, step)
  }
}

export function latestLookSlot(setting: BotLookAround, now: number): number | null {
  for (const slot of slotsFrom(setting, now, -1)) {
    if (slot <= now) {
      return slot
    }
  }
  return null
}

function nextLookSlot(setting: BotLookAround, after: number): number | null {
  for (const slot of slotsFrom(setting, after, 1)) {
    if (slot > after) {
      return slot
    }
  }
  return null
}

/** Whether `at` is one of the schedule's slots as it stands now. */
function isCurrentSlot(setting: BotLookAround, at: number): boolean {
  const calendar = automationScheduleCalendar(lookAroundZone(setting))
  return slotsOnDay(setting, calendar.startOfDay(at)).includes(at)
}

/** Each listed time's last `count` slots at or before `until`, over scheduled days only (a weekend
 *  never breaks a weekdays-only streak), newest first; keyed by the listed time. */
export function recentSlotsByTime(
  setting: BotLookAround,
  until: number,
  count: number
): Map<string, number[]> {
  const calendar = automationScheduleCalendar(lookAroundZone(setting))
  const times = lookAroundTimes(setting)
  const byTime = new Map<string, number[]>(times.map((time) => [time, []]))
  // A weekdays-only schedule needs at most 7 calendar days per 5 slots of one time.
  const days = Math.ceil(count * 1.5) + 3
  let day = calendar.startOfDay(until)
  for (let index = 0; index <= days; index += 1) {
    const slots = slotsOnDay(setting, day)
    times.forEach((time, position) => {
      const slot = slots[position]
      const list = byTime.get(time)
      if (slot !== undefined && slot <= until && list && list.length < count) {
        list.push(slot)
      }
    })
    day = calendar.addDays(day, -1)
  }
  return byTime
}

/** `ends`: when the slot's catch-up ends. */
function takes(
  run: LookAroundRun,
  slot: number,
  ends: number,
  current: ReadonlySet<number>
): boolean {
  return run.scheduledFor !== undefined && current.has(run.scheduledFor)
    ? run.scheduledFor === slot
    : inLookNowWindow(run.startedAt, slot, ends)
}

/** A Look now started from LOOK_RECENT_MS before a slot until its catch-up ends (an hour after it at
 *  least) could stand in for it. */
function inLookNowWindow(startedAt: number, slot: number, ends: number): boolean {
  return startedAt >= slot - LOOK_RECENT_MS && startedAt <= Math.max(slot + LOOK_RECENT_MS, ends)
}

/** The one slot a Look now stands in for, never two: the overdue one (a slot at or before it whose
 *  window it started in, not taken by its own scheduled look or an earlier Look now; the latest, if
 *  several are), else the nearest slot after it whose window it started in. Slots 9:00 and 10:00: a
 *  Look now at 9:30 stands in for 9:00, and 10:00 still runs. Null when it started outside every
 *  window. A later slot's window never ends before an earlier one's, so the first overdue slot
 *  outside its window ends the search back. */
function lookNowSlot(
  setting: BotLookAround,
  startedAt: number,
  takenBefore: ReadonlySet<number>
): number | null {
  // A window ends by the next day's start or an hour after its slot, so yesterday is far enough back.
  for (const slot of slotsFrom(setting, startedAt, -1, 1)) {
    if (slot > startedAt || takenBefore.has(slot)) {
      continue
    }
    if (!inLookNowWindow(startedAt, slot, catchUpEnds(setting, slot))) {
      break
    }
    return slot
  }
  const upcoming = nextLookSlot(setting, startedAt)
  return upcoming !== null && inLookNowWindow(startedAt, upcoming, catchUpEnds(setting, upcoming))
    ? upcoming
    : null
}

/** A slot is taken by its own scheduled look, or by the one Look now (any look without a slot, as
 *  older records' looks are) that stands in for it (see lookNowSlot), each Look now in the order
 *  they started. A scheduled look for another current slot never takes it, however late it started;
 *  one for a slot the schedule no longer has (the owner moved a time) counts as a Look now, so an
 *  edit can't start a second look minutes after the first. A look the host's sleep or a usage limit
 *  cut short never takes a slot. */
function slotTakers(
  setting: BotLookAround,
  runs: readonly LookAroundRun[]
): (slot: number) => LookAroundRun | undefined {
  const current = new Set(
    runs.flatMap((run) =>
      run.scheduledFor !== undefined && isCurrentSlot(setting, run.scheduledFor)
        ? [run.scheduledFor]
        : []
    )
  )
  const ownSlot = (run: LookAroundRun): boolean =>
    run.scheduledFor !== undefined && current.has(run.scheduledFor)
  const taken = new Set(
    runs.flatMap((run) =>
      !missedRun(run) && run.scheduledFor !== undefined && ownSlot(run) ? [run.scheduledFor] : []
    )
  )
  const standsInFor = new Map<LookAroundRun, number>()
  for (const run of runs) {
    if (missedRun(run) || ownSlot(run)) {
      continue
    }
    const slot = lookNowSlot(setting, run.startedAt, taken)
    if (slot !== null) {
      standsInFor.set(run, slot)
      taken.add(slot)
    }
  }
  return (slot) =>
    runs.findLast(
      (run) =>
        !missedRun(run) &&
        (ownSlot(run) ? run.scheduledFor === slot : standsInFor.get(run) === slot)
    )
}

/** When the slot may be tried again after a look the host's sleep or a usage limit cut short; 0
 *  when none did. Only waiting a little after each, so a host that keeps sleeping doesn't start one
 *  every tick. */
function retryAt(setting: BotLookAround, runs: readonly LookAroundRun[], slot: number): number {
  const current = new Set(
    runs.flatMap((run) => (run.scheduledFor !== undefined ? [run.scheduledFor] : []))
  )
  const ends = catchUpEnds(setting, slot)
  const cut = runs.findLast((run) => missedRun(run) && takes(run, slot, ends, current))
  return cut ? (cut.endedAt ?? cut.startedAt) + ASLEEP_RETRY_AFTER_MS : 0
}

/** Until when a slot due now may still start: the next slot, or the end of its day. */
function catchUpEnds(setting: BotLookAround, slot: number): number {
  const calendar = automationScheduleCalendar(lookAroundZone(setting))
  const dayEnds = calendar.addDays(calendar.startOfDay(slot), 1)
  const next = nextLookSlot(setting, slot)
  return next === null ? dayEnds : Math.min(next, dayEnds)
}

/** Slots before this are decided: run, or gone by. The latest slot today is still catching up;
 *  every slot before it, or before today, is over. */
export function decidedBefore(setting: BotLookAround, now: number): number {
  const today = automationScheduleCalendar(lookAroundZone(setting)).startOfDay(now)
  const latest = latestLookSlot(setting, now)
  return latest !== null && latest >= today ? latest : today
}

/** The latest slot whose catch-up ended with no look: one the next slot or the day's end passed.
 *  A newer due or completed look never hides it. */
function latestExpiredUntakenSlot(
  setting: BotLookAround,
  state: BotLookState,
  now: number,
  allowedFrom: number,
  taken: (slot: number) => LookAroundRun | undefined
): number | undefined {
  const before = decidedBefore(setting, now)
  const oldest = state.runs[0]
  // Trimmed runs no longer tell whether an older slot was taken.
  const knownFrom =
    state.pastSessionIds?.length && oldest
      ? Math.max(allowedFrom, oldest.scheduledFor ?? oldest.startedAt)
      : allowedFrom
  for (const slot of slotsFrom(setting, before, -1)) {
    if (slot >= before) {
      continue
    }
    if (slot < knownFrom) {
      break
    }
    if (!taken(slot)) {
      return slot
    }
  }
  return undefined
}

function firstAllowedAt(setting: BotLookAround, armedAt: number): number {
  return armedAt + lookAroundIntervalMs(setting)
}

export type LookDecision = {
  /** The slot to start now; null when none is. */
  due: number | null
  /** "Next look": the due slot while it waits to start, else the next slot that will run. */
  next?: {
    at: number
    /** Owed now: it starts once the host is in full wake, by `until`. */
    due?: true
    until?: number
    /** A slot before `at` that a Look now stands in for. */
    skipped?: { at: number; lookedAt: number }
  }
  /** The latest slot that passed without a look, past its grace. */
  missedAt?: number
}

/** Whether a look is due, when the next one is, and which slot went by without one. Undefined
 *  `next` before the first conversation. */
export function lookAroundDecision(
  setting: BotLookAround,
  state: BotLookState,
  now: number
): LookDecision {
  if (state.armedAt === undefined || lookAroundTimes(setting).length === 0) {
    return { due: null }
  }
  // Turned on later: a slot from before it is never caught up.
  const allowedFrom = Math.max(firstAllowedAt(setting, state.armedAt), setting.since ?? 0)
  const taken = slotTakers(setting, state.runs)
  const latest = latestLookSlot(setting, now)
  const calendar = automationScheduleCalendar(lookAroundZone(setting))
  const owedSlot =
    latest !== null && latest >= allowedFrom && latest >= calendar.startOfDay(now) && !taken(latest)
      ? latest
      : null
  // No scheduled look starts before the reset of a usage limit that ended the last one.
  const limitedUntil = usageLimitedUntil(state.runs)
  const retry = owedSlot !== null ? retryAt(setting, state.runs, owedSlot) : 0
  const ends = owedSlot !== null ? catchUpEnds(setting, owedSlot) : 0
  // A usage limit holding the owed slot past its catch-up gives it up to the next slot.
  const owed = owedSlot !== null && limitedUntil < ends ? owedSlot : null
  // Owed, but not started yet while a try the host's sleep or a usage limit cut short waits.
  const due = owed !== null && now >= retry && now >= limitedUntil ? owed : null
  const missedAt = latestExpiredUntakenSlot(setting, state, now, allowedFrom, taken)
  const startsAt = Math.max(retry, limitedUntil)
  // Held by a usage limit, Next look is when it may start: at the reset, or once its retry waits.
  const held = owed !== null && limitedUntil > 0 && startsAt > now
  if (owed !== null && !(held && startsAt >= ends)) {
    return {
      due,
      next: held ? { at: startsAt } : { at: owed, due: true, until: ends },
      ...(missedAt !== undefined ? { missedAt } : {})
    }
  }
  let after = Math.max(now, allowedFrom - 1, limitedUntil)
  let skipped: NonNullable<LookDecision['next']>['skipped']
  // A Look now takes at most one slot (lookNowSlot), so this skips one per look; the cap is a backstop.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const at = nextLookSlot(setting, after)
    if (at === null) {
      break
    }
    const run = taken(at)
    if (!run) {
      return {
        due,
        next: { at, ...(skipped ? { skipped } : {}) },
        ...(missedAt ? { missedAt } : {})
      }
    }
    skipped = { at, lookedAt: run.startedAt }
    after = at
  }
  return { due, ...(missedAt ? { missedAt } : {}) }
}

/** The slot due now, or null: before its first interval or turned on, already taken, waiting out a
 *  retry, or from before the next slot or today. */
export function lookAroundDueAt(
  setting: BotLookAround,
  state: BotLookState,
  now: number
): number | null {
  return lookAroundDecision(setting, state, now).due
}
