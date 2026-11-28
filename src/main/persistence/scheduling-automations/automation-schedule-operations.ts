import type {
  Automation,
  AutomationUpdateInput
} from '../../../shared/automations/automation-definition'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import {
  latestAutomationOccurrenceAtOrBefore,
  nextAutomationOccurrenceAfter
} from '../../../shared/automations/scheduling/automation-schedule-occurrences'
import type { AutomationStorageAuthority } from './automation-owner-projection'

/**
 * The zone an automation's hours are read in; undefined reads the host's own clock. A desktop
 * follows its clock wherever it travels, like an alarm; a server keeps the zone its owner's client
 * saved; a zone the owner named holds everywhere.
 */
export function automationScheduleZone(
  automation: Pick<Automation, 'timezone' | 'timezoneExplicit'>,
  authority: AutomationStorageAuthority
): string | undefined {
  return automation.timezoneExplicit || authority === 'runtime' ? automation.timezone : undefined
}

/** A new automation's first run, read in the zone its hours belong to. */
export function firstAutomationRunAt(
  automation: Pick<Automation, 'rrule' | 'dtstart' | 'timezone' | 'timezoneExplicit'>,
  authority: AutomationStorageAuthority,
  now: number
): ReturnType<typeof nextAutomationOccurrenceAfter> {
  const zone = automationScheduleZone(automation, authority)
  return nextAutomationOccurrenceAfter(automation.rrule, automation.dtstart, now, zone)
}

export function advanceAutomationNextRun(
  state: PersistedState,
  flush: () => void,
  id: string,
  authority: AutomationStorageAuthority,
  now = Date.now()
): Automation {
  const index = (state.automations ?? []).findIndex((entry) => entry.id === id)
  if (index === -1) {
    throw new Error('Automation not found.')
  }
  const current = state.automations[index]
  const nextRunAt = nextAutomationOccurrenceAfter(
    current.rrule,
    current.dtstart,
    now,
    automationScheduleZone(current, authority)
  )
  const updated = { ...current, nextRunAt, updatedAt: now }
  // Replace the array to invalidate identity-keyed list projections.
  state.automations = state.automations.map((entry) => (entry.id === id ? updated : entry))
  flush()
  return updated
}

/** Moves each recurring schedule's next run past `now` in one list write and one flush. */
export function advanceAutomationNextRuns(
  state: PersistedState,
  flush: () => void,
  ids: ReadonlySet<string>,
  authority: AutomationStorageAuthority,
  now = Date.now()
): number {
  if (ids.size === 0) {
    return 0
  }
  let advanced = 0
  const automations = (state.automations ?? []).map((entry) => {
    if (!ids.has(entry.id) || entry.once) {
      return entry
    }
    advanced += 1
    const nextRunAt = nextAutomationOccurrenceAfter(
      entry.rrule,
      entry.dtstart,
      now,
      automationScheduleZone(entry, authority)
    )
    return { ...entry, nextRunAt, updatedAt: now }
  })
  if (advanced > 0) {
    // Replace the array to invalidate identity-keyed list projections.
    state.automations = automations
    flush()
  }
  return advanced
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
  authority: AutomationStorageAuthority,
  now = Date.now()
): number | null {
  return latestAutomationOccurrenceAtOrBefore(
    automation.rrule,
    automation.dtstart,
    now,
    automationScheduleZone(automation, authority)
  )
}

/** An edit's schedule; it reschedules only when when-it-runs changed, not on every save. */
export function updatedAutomationSchedule(
  current: Automation,
  updates: AutomationUpdateInput,
  authority: AutomationStorageAuthority,
  now = Date.now()
): Pick<Automation, 'rrule' | 'dtstart' | 'timezone' | 'nextRunAt'> {
  const rrule = updates.rrule ?? current.rrule
  const dtstart = updates.dtstart ?? current.dtstart
  // A save without a named zone (the editor resends its own) never replaces one the owner named.
  const keepsNamedZone = current.timezoneExplicit === true && updates.timezoneExplicit !== true
  const timezone = keepsNamedZone ? current.timezone : (updates.timezone ?? current.timezone)
  const zone = automationScheduleZone(
    { timezone, timezoneExplicit: updates.timezoneExplicit ?? current.timezoneExplicit },
    authority
  )
  // Saves always resend the zone, so only one that reads differently counts.
  const changed =
    updates.rrule !== undefined ||
    updates.dtstart !== undefined ||
    zone !== automationScheduleZone(current, authority)
  return {
    rrule,
    dtstart,
    timezone,
    nextRunAt: changed
      ? nextAutomationOccurrenceAfter(rrule, dtstart, now, zone)
      : current.nextRunAt
  }
}
