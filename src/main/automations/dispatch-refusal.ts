/**
 * What the owning authority says, and writes, when it refuses to start a run.
 *
 * Kept together because every refusal must be one fixed sentence: skip
 * coalescing folds repeats only on byte-identical text, so a reason that varied
 * per occurrence would write a row each.
 */
import type { Store } from '../persistence'
import type { Automation } from '../../shared/automations-types'
import { resolveAutomationRunTarget, type AutomationRunTargetResult } from './run-target-resolution'
import type { AutomationRunWriter } from './automation-run-writer'

export const NO_DISPATCH_HOST = 'No Orca window was available to launch the automation.'

/** A record the authority refuses to execute at all, with no target diagnosis of its own. */
export const NO_RUNNABLE_HOST = 'This automation has no host to run on.'

/** Every reason this occurrence cannot start, decided before a run row exists so
 *  the scheduler can fold repeats instead of writing one row each. */
export function describeScheduledRefusal(input: {
  target: AutomationRunTargetResult
  canDispatch: boolean
}): string | null {
  if (!input.target.ok) {
    return input.target.error
  }
  return input.canDispatch ? null : NO_DISPATCH_HOST
}

/**
 * Records the manual attempt an execute fence refused before dispatch existed.
 *
 * The typed conflict answers the caller; run history is what answers the user,
 * and doc:94 asks for both. Never dispatches: the reason is the one the
 * scheduler would have written for the same record.
 */
export function recordRefusedAutomationRun(input: {
  store: Store
  runs: AutomationRunWriter
  automation: Automation
  allowRemoteHostScheduling: boolean
}): void {
  const target = resolveAutomationRunTarget(input.store, input.automation, {
    allowRemoteHostScheduling: input.allowRemoteHostScheduling
  })
  const run = input.runs.createRun(input.automation, Date.now(), 'manual')
  input.runs.updateRun({
    runId: run.id,
    status: 'skipped_unavailable',
    workspaceId: input.automation.workspaceId,
    error: target.ok ? NO_RUNNABLE_HOST : target.error
  })
}
