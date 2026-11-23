import type { Automation } from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import { nextAutomationOccurrenceAfter } from '../../../shared/automations/scheduling/automation-schedule-occurrences'
import { pruneAutomationRuns } from '../../../shared/automations/history/automation-run-retention'
import type { AutomationStorageAuthority } from './automation-owner-projection'
import { automationScheduleZone } from './automation-schedule-operations'
import {
  createAutomationRun,
  updateAutomationRun,
  type AutomationRunOperations
} from './automation-run-operations'

type Recovery = NonNullable<AutomationRun['missedOccurrenceRecovery']>

/** Claim the gap and checkpoint its history together; nextRunAt remains the operational clock. */
export function recordMissedAutomationOccurrences(
  operations: AutomationRunOperations,
  automation: Automation,
  authority: AutomationStorageAuthority,
  before: number
): boolean {
  const current = operations.state.automations.find((entry) => entry.id === automation.id)
  if (!current?.enabled || current.nextRunAt !== automation.nextRunAt) {
    return false
  }
  const timezone =
    automationScheduleZone(current, authority) ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const history = (operations.state.automationRuns ?? []).filter(
    (run) => run.automationId === current.id
  )
  const pending = history.filter((run) => run.missedOccurrenceRecovery)
  const newRecovery: Recovery = {
    rrule: current.rrule,
    dtstart: current.dtstart,
    timezone,
    nextAt: current.nextRunAt,
    before
  }
  const plans: {
    run?: AutomationRun
    recovery: Recovery
    first: number
    last: number
    count: number
  }[] = []
  let remaining = 256
  let remainingSpan = 32 * 24 * 60 * 60 * 1000
  const candidates = [
    ...(current.nextRunAt < before ? [{ run: undefined, recovery: newRecovery }] : []),
    ...pending.map((run) => ({ run, recovery: run.missedOccurrenceRecovery! }))
  ]
  for (const candidate of candidates) {
    if (remaining === 0 || remainingSpan <= 0) {
      break
    }
    const recovery = { ...candidate.recovery }
    const next = (after: number) =>
      nextAutomationOccurrenceAfter(recovery.rrule, recovery.dtstart, after, recovery.timezone)
    // A desktop may have moved zones since nextRunAt was saved.
    let first = next(recovery.nextAt - 1)
    let cursor = first
    let last = first
    let count = 0
    const start = first
    const horizon = first + remainingSpan
    while (cursor < recovery.before && cursor < horizon && remaining > 0) {
      const represented = history.find(
        (run) =>
          run.id !== candidate.run?.id &&
          run.trigger !== 'event' &&
          cursor >= run.scheduledFor &&
          cursor <= (run.lastOccurrenceAt ?? run.scheduledFor)
      )
      if (!represented) {
        if (count === 0) {
          first = cursor
        }
        last = cursor
        count += 1
      }
      cursor = next(
        represented ? (represented.lastOccurrenceAt ?? represented.scheduledFor) : cursor
      )
      remaining -= 1
    }
    recovery.nextAt = cursor
    remainingSpan -= Math.max(0, cursor - start)
    if (count > 0 || candidate.run) {
      plans.push({ run: candidate.run, recovery, first, last, count })
    }
  }
  if (plans.length === 0 && current.nextRunAt >= before) {
    return true
  }
  // No intermediate pending row or partial count can be persisted ahead of its checkpoint.
  const batchOperations = { ...operations, flush: () => {} }
  for (const plan of plans) {
    let run = plan.run
    if (!run) {
      const created = createAutomationRun(batchOperations, current, plan.first)
      run = updateAutomationRun(batchOperations, {
        runId: created.id,
        status: 'skipped_missed',
        error: 'Orca skipped this occurrence because a newer scheduled occurrence was due.'
      })
    }
    const { missedOccurrenceRecovery: _recovery, ...previous } = run
    const updated: AutomationRun = {
      ...previous,
      createdAt:
        plan.run && plan.recovery.nextAt >= plan.recovery.before ? Date.now() : run.createdAt,
      occurrenceCount: (plan.run ? (run.occurrenceCount ?? 1) : 0) + plan.count,
      lastOccurrenceAt: plan.count > 0 ? plan.last : run.lastOccurrenceAt,
      ...(plan.recovery.nextAt < plan.recovery.before
        ? { missedOccurrenceRecovery: plan.recovery }
        : {})
    }
    operations.state.automationRuns = operations.state.automationRuns.map((entry) =>
      entry.id === run.id ? updated : entry
    )
  }
  operations.state.automationRuns = pruneAutomationRuns(operations.state.automationRuns)
  operations.recordAutomationRunsMutation?.(operations.state.automationRuns)
  operations.state.automations = operations.state.automations.map((entry) =>
    entry.id === current.id ? { ...entry, nextRunAt: Math.max(entry.nextRunAt, before) } : entry
  )
  operations.flush()
  return true
}
