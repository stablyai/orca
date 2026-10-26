// Skip coalescing requires a fixed, byte-identical sentence for each refusal reason.
import type { WebContents } from 'electron'
import type { Store } from '../persistence'
import type {
  Automation,
  AutomationDispatchRequest,
  AutomationRun
} from '../../shared/automations-types'
import { resolveAutomationRunTarget, type AutomationRunTargetResult } from './run-target-resolution'
import type { AutomationRunWriter } from './automation-run-writer'
import { wslMoveRepoBackoff } from '../persistence/moving-wsl-projects/wsl-move-background-backoff'

export const NO_DISPATCH_HOST = 'No Orca window was available to launch the automation.'

export const UNEVALUABLE_SCHEDULE =
  'Orca could not evaluate this automation and skipped the occurrence.'

export const NO_RUNNABLE_HOST = 'This automation has no host to run on.'

export const WSL_MOVE_IN_PROGRESS =
  "This automation's project is moving to its WSL host, so Orca skipped this run. Runs resume when the move finishes."

export const WSL_MOVE_OWNED_BY_HOST =
  "This automation's project now runs on its WSL host, which runs this automation there. Orca no longer runs this local copy."

/** Decide refusals before creating rows so repeated skips can coalesce. */
export function describeScheduledRefusal(input: {
  target: AutomationRunTargetResult
  canDispatch: boolean
}): string | null {
  if (!input.target.ok) {
    return input.target.error
  }
  const backoff = wslMoveRepoBackoff(input.target.repo)
  if (backoff) {
    return backoff === 'moving' ? WSL_MOVE_IN_PROGRESS : WSL_MOVE_OWNED_BY_HOST
  }
  return input.canDispatch ? null : NO_DISPATCH_HOST
}

/** Record refused manual attempts so run history agrees with the caller’s typed conflict. */
export async function recordRefusedAutomationRun(input: {
  store: Store
  runs: AutomationRunWriter
  automation: Automation
  allowRemoteHostScheduling: boolean
}): Promise<void> {
  const target = resolveAutomationRunTarget(input.store, input.automation, {
    allowRemoteHostScheduling: input.allowRemoteHostScheduling
  })
  const run = await input.runs.createRun(input.automation, Date.now(), 'manual')
  await input.runs.updateRun({
    runId: run.id,
    status: 'skipped_unavailable',
    workspaceId: input.automation.workspaceId,
    error: target.ok ? NO_RUNNABLE_HOST : target.error
  })
}

/** Fold broken schedules into one retained skip without interrupting the scheduler tick. */
export async function recordUnevaluableAutomation(input: {
  runs: AutomationRunWriter
  automation: Automation
  error: unknown
}): Promise<void> {
  const { automation } = input
  try {
    // Keep nextRunAt for automatic retry after repair; fold repeated failures to avoid row churn.
    if (await input.runs.repeatSkip(automation.id, UNEVALUABLE_SCHEDULE, automation.nextRunAt)) {
      return
    }
    console.error('[automations] failed to evaluate automation:', automation.id, input.error)
    const run = await input.runs.createRun(automation, automation.nextRunAt)
    if (run.status !== 'pending') {
      return
    }
    await input.runs.updateRun({
      runId: run.id,
      status: 'skipped_unavailable',
      workspaceId: automation.workspaceId,
      error: UNEVALUABLE_SCHEDULE
    })
  } catch (writeError) {
    console.error(
      '[automations] failed to record unevaluable automation:',
      automation.id,
      input.error,
      writeError
    )
  }
}

export async function sendRendererDispatch(
  channel: Pick<WebContents, 'send'> | null,
  payload: AutomationDispatchRequest,
  runs: AutomationRunWriter,
  run: AutomationRun
): Promise<AutomationRun> {
  try {
    channel?.send('automations:dispatchRequested', payload)
    return run
  } catch (error) {
    return runs.updateRun({
      runId: run.id,
      status: 'dispatch_failed',
      workspaceId: run.workspaceId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}

/** Allow tick jitter beyond downtime grace; elapsed time still catches system sleep.
 * Short outages inside the tolerance are accepted; long inline dispatches may still exceed it. */
export function missedBeyondGrace(input: {
  automation: Automation
  scheduledFor: number
  now: number
  tickMs: number
}): boolean {
  const graceMs = input.automation.missedRunGraceMinutes * 60 * 1000
  // Allow one interval for the next tick and another for jitter.
  const jitterMs = input.tickMs * 2
  return input.now - input.scheduledFor > graceMs + jitterMs
}

export async function recordMissedRun(input: {
  runs: AutomationRunWriter
  automation: Automation
  scheduledFor: number
}): Promise<void> {
  const missed = await input.runs.createRun(input.automation, input.scheduledFor)
  if (missed.status !== 'pending') {
    return
  }
  await input.runs.updateRun({
    runId: missed.id,
    status: 'skipped_missed',
    workspaceId: input.automation.workspaceId,
    error: 'This run was past its missed-run grace window when Orca next checked.'
  })
}
