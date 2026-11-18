import type { Automation } from '../../../shared/automations/automation-definition'
import type { AutomationStorageAuthority } from './automation-owner-projection'
import { automationScheduleZone } from './automation-schedule-operations'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from '../../../shared/automations/scheduling/automation-schedule-occurrences'

/**
 * An automation read in a saved zone (a server's, or one its owner named) whose next run an older
 * Orca saved on the host clock: that run is not one of its occurrences. Re-seed it on the zone
 * instead of letting catch-up read it as a miss or a late run; no run is recorded.
 */
export function reseedOffZoneNextRuns(
  automations: readonly Automation[],
  authority: AutomationStorageAuthority,
  now = Date.now()
): { automations: Automation[]; changed: boolean } {
  let changed = false
  const next = automations.map((automation) => {
    const { rrule, dtstart, nextRunAt } = automation
    const timezone = automationScheduleZone(automation, authority)
    // On the host's own clock (a desktop's default zone) nothing was saved on another clock.
    if (timezone === undefined) {
      return automation
    }
    try {
      if (latestAutomationOccurrenceAtOrBefore(rrule, dtstart, nextRunAt, timezone) === nextRunAt) {
        return automation
      }
      const reseeded = nextAutomationOccurrenceAfter(rrule, dtstart, now, timezone)
      changed = true
      return { ...automation, nextRunAt: reseeded }
    } catch {
      // A schedule with no readable next run is the dispatcher's to report, as before.
      return automation
    }
  })
  return { automations: changed ? next : [...automations], changed }
}

/** A loaded state with its off-zone next runs re-seeded; a moved run marks the load for saving. */
export function reseedLoadedAutomationZones<T extends { automations?: Automation[] }>(
  state: T,
  runtime: { storageAuthority: AutomationStorageAuthority; loadNeedsSave: boolean }
): T {
  const reseed = reseedOffZoneNextRuns(state.automations ?? [], runtime.storageAuthority)
  if (!reseed.changed) {
    return state
  }
  runtime.loadNeedsSave = true
  return { ...state, automations: reseed.automations }
}
