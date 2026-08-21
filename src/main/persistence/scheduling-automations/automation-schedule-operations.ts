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

export function getLatestAutomationOccurrence(
  automation: Automation,
  now = Date.now()
): number | null {
  return latestAutomationOccurrenceAtOrBefore(automation.rrule, automation.dtstart, now)
}
