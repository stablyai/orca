import {
  isFinalAutomationRunStatus,
  type AutomationRun
} from '../../../shared/automations/history/automation-run'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import {
  runHasEvent,
  withFoldedEvent,
  type AutomationRunEvent
} from '../../../shared/automation-event-triggers'
import type { AutomationRunOperations } from './automation-run-operations'

export function touchAutomation(state: PersistedState, automationId: string, now: number): void {
  if (!state.automations.some((entry) => entry.id === automationId)) {
    return
  }
  state.automations = state.automations.map((entry) =>
    entry.id === automationId ? { ...entry, lastRunAt: now, updatedAt: now } : entry
  )
}

/** Count a repeat event on a thread, PR or issue into its unfinished run instead of starting another. */
export function foldAutomationEvent(
  operations: AutomationRunOperations,
  automationId: string,
  event: AutomationRunEvent
): AutomationRun | null {
  const active = (operations.state.automationRuns ?? []).find(
    (run) =>
      run.automationId === automationId &&
      run.trigger === 'event' &&
      event.subject !== undefined &&
      run.event?.subject === event.subject &&
      !isFinalAutomationRunStatus(run.status)
  )
  return active ? foldOccurrence(operations, active, event.occurredAt, event) : null
}

// A repeat is the same occurrence, or for events the same source event.
export function foldOccurrence(
  operations: AutomationRunOperations,
  run: AutomationRun,
  occurredAt: number,
  event: AutomationRunEvent | undefined
): AutomationRun {
  if (
    event ? runHasEvent(run, event.key) : (run.lastOccurrenceAt ?? run.scheduledFor) === occurredAt
  ) {
    return run
  }
  const counted: AutomationRun = {
    ...run,
    occurrenceCount: (run.occurrenceCount ?? 1) + 1,
    // A late event is counted but never moves the latest occurrence back.
    lastOccurrenceAt: Math.max(run.lastOccurrenceAt ?? run.scheduledFor, occurredAt)
  }
  const updated = event ? withFoldedEvent(counted, event) : counted
  // Replace the array to invalidate identity-keyed list projections.
  operations.state.automationRuns = operations.state.automationRuns.map((entry) =>
    entry.id === run.id ? updated : entry
  )
  operations.recordAutomationRunsMutation?.(operations.state.automationRuns)
  touchAutomation(operations.state, run.automationId, Date.now())
  operations.flush()
  return updated
}
