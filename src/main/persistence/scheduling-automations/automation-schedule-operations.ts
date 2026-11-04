import type { Automation } from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { parseAutomationOnceSchedule } from '../../../shared/automation-once-schedule'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from '../../../shared/automation-schedule-occurrences'

export function advanceAutomationNextRun(
  state: PersistedState,
  flush: () => void,
  id: string,
  now = Date.now()
): Automation {
  const index = (state.automations ?? []).findIndex((entry) => entry.id === id)
  if (index === -1) {
    throw new Error('Automation not found.')
  }
  const current = state.automations[index]
  const once = parseAutomationOnceSchedule(current.rrule)
  const finished = once !== null && once.runAt <= now
  const nextRunAt = finished
    ? current.nextRunAt
    : nextAutomationOccurrenceAfter(current.rrule, current.dtstart, now)
  const updated = {
    ...current,
    nextRunAt,
    enabled: finished ? false : current.enabled,
    updatedAt: now
  }
  // Replace the array to invalidate identity-keyed list projections.
  state.automations = state.automations.map((entry) => (entry.id === id ? updated : entry))
  flush()
  return updated
}

/** Bypasses owner fencing: callers disable rows another authority now schedules. */
export function disableAutomations(
  state: PersistedState,
  flush: () => void,
  ids: ReadonlySet<string>
): number {
  let disabled = 0
  const now = Date.now()
  const automations = (state.automations ?? []).map((entry) => {
    if (!entry.enabled || !ids.has(entry.id)) {
      return entry
    }
    disabled += 1
    return { ...entry, enabled: false, updatedAt: now }
  })
  if (disabled > 0) {
    state.automations = automations
    flush()
  }
  return disabled
}

export function getLatestAutomationOccurrence(
  automation: Automation,
  now = Date.now()
): number | null {
  return latestAutomationOccurrenceAtOrBefore(automation.rrule, automation.dtstart, now)
}
