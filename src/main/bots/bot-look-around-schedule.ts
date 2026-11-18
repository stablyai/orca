// When a bot's next look is due: its Look around hours, from one interval after its first conversation.
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from '../../shared/automations/scheduling/automation-schedule-occurrences'
import { startOfLocalDay } from '../../shared/automations/scheduling/automation-cron-occurrence'
import {
  lookAroundIntervalMs,
  lookAroundSchedule,
  type BotLookAround
} from '../../shared/bots/bot-look-around'
import { lastRunStartedAt, slotTaken, type BotLookState } from './bot-look-around-state'

/** A look started this soon before a slot, e.g. Look now, stands in for it. */
export const LOOK_RECENT_MS = 60 * 60 * 1000

function firstAllowedAt(setting: BotLookAround, armedAt: number): number {
  return armedAt + lookAroundIntervalMs(setting.every)
}

/** The slot due now, or null: before its first interval, already looked, or from an earlier day.
 *  A slot the host slept through is caught up on its first awake tick until the next slot, the
 *  same day; a look the host's sleep cut short leaves its slot to be tried again. */
export function lookAroundDueAt(
  setting: BotLookAround,
  state: BotLookState,
  now: number,
  /** False reads a slot waiting out its retry after a look sleep cut short as due, for Up next. */
  retrySpacing = true
): number | null {
  if (state.armedAt === undefined) {
    return null
  }
  const slot = latestAutomationOccurrenceAtOrBefore(lookAroundSchedule(setting), state.armedAt, now)
  if (
    slot === null ||
    slot < firstAllowedAt(setting, state.armedAt) ||
    slot < startOfLocalDay(now) ||
    slot < (setting.since ?? 0) ||
    slot - lastRunStartedAt(state.runs) < LOOK_RECENT_MS ||
    slotTaken(state.runs, slot, retrySpacing ? now : Number.POSITIVE_INFINITY)
  ) {
    return null
  }
  return slot
}

/** When the next look starts, for Up next's "Next look"; undefined before the first conversation. */
export function lookAroundNextAt(
  setting: BotLookAround,
  state: BotLookState,
  now: number
): number | undefined {
  if (state.armedAt === undefined) {
    return undefined
  }
  const after = Math.max(now, firstAllowedAt(setting, state.armedAt) - 1)
  return nextAutomationOccurrenceAfter(lookAroundSchedule(setting), state.armedAt, after)
}
