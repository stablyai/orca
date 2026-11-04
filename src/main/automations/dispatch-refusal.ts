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
import { isOrcadFencedAutomation } from './orcad-fenced-automation'
import { blockedWslDistroForPath } from '../wsl/wsl-unc-access-gate'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import {
  AUTOMATION_RUN_FAILURE_COPY,
  automationRunFailure,
  type AutomationRunFailure
} from '../../shared/automation-run-failure-copy'

export const NO_DISPATCH_HOST = AUTOMATION_RUN_FAILURE_COPY.noDispatchHost
export const WSL_MOVE_IN_PROGRESS = AUTOMATION_RUN_FAILURE_COPY.wslMoveInProgress
export const WSL_MOVE_OWNED_BY_HOST = AUTOMATION_RUN_FAILURE_COPY.wslMoveOwnedByHost

function targetFailure({
  ok: _ok,
  ...failure
}: Extract<AutomationRunTargetResult, { ok: false }>): AutomationRunFailure {
  return failure
}

/** Decide refusals before creating rows so repeated skips can coalesce. */
export function describeScheduledRefusal(input: {
  target: AutomationRunTargetResult
  canDispatch: boolean
}): AutomationRunFailure | null {
  if (!input.target.ok) {
    return targetFailure(input.target)
  }
  const backoff = wslMoveRepoBackoff(input.target.repo)
  if (backoff) {
    return automationRunFailure(backoff === 'moving' ? 'wslMoveInProgress' : 'wslMoveOwnedByHost')
  }
  return input.canDispatch ? null : automationRunFailure('noDispatchHost')
}

/**
 * E9: a scheduled run never starts a stopped (or unverifiable) WSL distro; Run now is the user's
 * act. A host-path project whose Git runs in WSL names its distro through the project runtime.
 */
export async function describeStoppedWslDistroRefusal(
  store: Store,
  target: Extract<AutomationRunTargetResult, { ok: true }>
): Promise<AutomationRunFailure | null> {
  let wslDistro: string | undefined
  try {
    wslDistro = getLocalProjectWorktreeGitOptions(store, target.repo).wslDistro
  } catch {
    // A runtime needing repair fails its own dispatch; the path alone still names a UNC distro.
  }
  const blocked = await blockedWslDistroForPath(target.cwd, wslDistro)
  return blocked ? automationRunFailure('wslDistroStopped', { distro: blocked.distro }) : null
}

/** A tick's refusal: the synchronous reasons, then a stopped WSL distro (an async read). */
export async function describeScheduledTickRefusal(
  store: Store,
  input: Parameters<typeof describeScheduledRefusal>[0]
): Promise<AutomationRunFailure | null> {
  return (
    describeScheduledRefusal(input) ??
    (input.target.ok ? await describeStoppedWslDistroRefusal(store, input.target) : null)
  )
}

/** Record refused manual attempts so run history agrees with the caller’s typed conflict. */
export async function recordRefusedAutomationRun(input: {
  store: Store
  runs: AutomationRunWriter
  automation: Automation
  allowRemoteHostScheduling: boolean
}): Promise<void> {
  if (isOrcadFencedAutomation(input.store, input.automation)) {
    return
  }
  const target = resolveAutomationRunTarget(input.store, input.automation, {
    allowRemoteHostScheduling: input.allowRemoteHostScheduling
  })
  const run = await input.runs.createRun(input.automation, Date.now(), 'manual')
  const failure = target.ok ? automationRunFailure('noRunnableHost') : targetFailure(target)
  await input.runs.updateRun({
    runId: run.id,
    status: 'skipped_unavailable',
    workspaceId: input.automation.workspaceId,
    ...failure
  })
}

/** Fold broken schedules into one retained skip without interrupting the scheduler tick. */
export async function recordUnevaluableAutomation(input: {
  runs: AutomationRunWriter
  automation: Automation
  error: unknown
}): Promise<void> {
  const { automation } = input
  const failure = automationRunFailure('unevaluableSchedule')
  try {
    // Keep nextRunAt for automatic retry after repair; fold repeated failures to avoid row churn.
    if (await input.runs.repeatSkip(automation.id, failure.error, automation.nextRunAt)) {
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
      ...failure
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
    ...automationRunFailure('missedGraceWindow')
  })
}
