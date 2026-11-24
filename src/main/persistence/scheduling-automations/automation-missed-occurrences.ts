import type { Automation } from '../../../shared/automations/automation-definition'
import {
  isRecoveringAutomationRun,
  type AutomationRun
} from '../../../shared/automations/history/automation-run'
import { errorMessage } from '../../../shared/errors/error-message'
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
type RecoveryBatch = {
  run?: AutomationRun
  recovery: Recovery
  first: number
  last: number
  count: number
}
type RecoveryBudget = { slots: number; spanMs: number }

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
  const pending = history.filter(isRecoveringAutomationRun)
  const newRecovery: Recovery = {
    rrule: current.rrule,
    dtstart: current.dtstart,
    timezone,
    nextAt: current.nextRunAt,
    before
  }
  const plans: RecoveryBatch[] = []
  const failures = new Map<string, string>()
  const budget: RecoveryBudget = { slots: 256, spanMs: 32 * 24 * 60 * 60 * 1000 }
  const candidates = [
    ...(current.nextRunAt < before ? [{ run: undefined, recovery: newRecovery }] : []),
    ...pending.map((run) => ({ run, recovery: run.missedOccurrenceRecovery! }))
  ]
  for (const candidate of candidates) {
    if (budget.slots === 0 || budget.spanMs <= 0) {
      break
    }
    try {
      const plan = countRecoveryBatch(candidate, history, budget)
      if (plan) {
        plans.push(plan)
      }
    } catch (error) {
      if (!candidate.run) {
        throw error
      }
      failures.set(candidate.run.id, errorMessage(error))
    }
  }
  if (plans.length === 0 && failures.size === 0 && current.nextRunAt >= before) {
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
  operations.state.automationRuns = operations.state.automationRuns.map((entry) => {
    const failure = failures.get(entry.id)
    if (failure === undefined) {
      return entry
    }
    const { errorCode: _code, errorParams: _params, ...run } = entry
    return {
      ...run,
      error: `Historical recovery could not finish counting missed occurrences: ${failure}`,
      missedOccurrenceRecovery: { ...entry.missedOccurrenceRecovery!, failure }
    }
  })
  operations.state.automationRuns = pruneAutomationRuns(operations.state.automationRuns)
  operations.recordAutomationRunsMutation?.(operations.state.automationRuns)
  operations.state.automations = operations.state.automations.map((entry) =>
    entry.id === current.id ? { ...entry, nextRunAt: Math.max(entry.nextRunAt, before) } : entry
  )
  operations.flush()
  return true
}

function countRecoveryBatch(
  candidate: { run?: AutomationRun; recovery: Recovery },
  history: AutomationRun[],
  budget: RecoveryBudget
): RecoveryBatch | null {
  const recovery = { ...candidate.recovery }
  if (
    typeof recovery.rrule !== 'string' ||
    typeof recovery.timezone !== 'string' ||
    recovery.timezone.length === 0 ||
    ![recovery.dtstart, recovery.nextAt, recovery.before].every(
      (at) => Number.isFinite(at) && Math.abs(at) <= 8.64e15
    ) ||
    recovery.nextAt < recovery.dtstart ||
    recovery.nextAt >= recovery.before ||
    (candidate.run &&
      recovery.nextAt <= (candidate.run.lastOccurrenceAt ?? candidate.run.scheduledFor))
  ) {
    throw new Error('Invalid historical recovery interval.')
  }
  const next = (after: number) =>
    nextAutomationOccurrenceAfter(recovery.rrule, recovery.dtstart, after, recovery.timezone)
  // A desktop may have moved zones since nextRunAt was saved.
  let first = next(recovery.nextAt - 1)
  let cursor = first
  let last = first
  let count = 0
  const start = first
  const horizon = first + budget.spanMs
  while (cursor < recovery.before && cursor < horizon && budget.slots > 0) {
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
    budget.slots -= 1
    cursor = next(represented ? (represented.lastOccurrenceAt ?? represented.scheduledFor) : cursor)
  }
  recovery.nextAt = cursor
  budget.spanMs -= Math.max(0, cursor - start)
  return count > 0 || candidate.run ? { run: candidate.run, recovery, first, last, count } : null
}
