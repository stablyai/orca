import type { Automation } from '../../../shared/automations-types'
import type { StoreOwnedPersistedState } from '../loading-store/store-owned-state'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from '../../../shared/automation-schedules'

export function advanceAutomationNextRun(
  state: StoreOwnedPersistedState,
  flush: () => void,
  id: string,
  now = Date.now()
): Automation {
  const index = (state.automations ?? []).findIndex((entry) => entry.id === id)
  if (index === -1) {
    throw new Error('Automation not found.')
  }
  const current = state.automations[index]
  const nextRunAt = nextAutomationOccurrenceAfter(current.rrule, current.dtstart, now)
  const updated = { ...current, nextRunAt, updatedAt: now }
  state.automations[index] = updated
  flush()
  return updated
}

// Why (#15895): the schedule-error path cannot go through advanceAutomationNextRun — that
// re-parses the very rrule that just failed to parse, so the failure handler would throw a
// second time and the broken row would retry (and record an errored run) on every tick.
// Defer by a fixed backoff instead: the schedule stays broken until the user edits it, and
// the hourly retry keeps the failure visible without spamming run history.
export const AUTOMATION_SCHEDULE_ERROR_RETRY_MS = 60 * 60 * 1000

export function deferAutomationNextRunAfterScheduleError(
  state: StoreOwnedPersistedState,
  flush: () => void,
  id: string,
  now = Date.now()
): Automation | null {
  const index = (state.automations ?? []).findIndex((entry) => entry.id === id)
  if (index === -1) {
    return null
  }
  const current = state.automations[index]
  const updated = {
    ...current,
    nextRunAt: now + AUTOMATION_SCHEDULE_ERROR_RETRY_MS,
    updatedAt: now
  }
  state.automations[index] = updated
  flush()
  return updated
}

export function getLatestAutomationOccurrence(
  automation: Automation,
  now = Date.now()
): number | null {
  return latestAutomationOccurrenceAtOrBefore(automation.rrule, automation.dtstart, now)
}
