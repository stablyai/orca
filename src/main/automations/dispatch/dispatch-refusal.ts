// Skip coalescing requires a fixed, byte-identical sentence for each refusal reason.
import type { Store } from '../../persistence/loading-store/store'
import type { Automation } from '../../../shared/automations/automation-definition'
import type { AutomationRun } from '../../../shared/automations/history/automation-run'
import {
  resolveAutomationRunTarget,
  type AutomationRunTargetResult
} from '../ownership/run-target-resolution'
import type { AutomationRunWriter } from '../run-history/run-writer'
import { wslMoveRepoBackoff } from '../../persistence/moving-wsl-projects/orchestration/wsl-move-background-backoff'
import { isOrcadFencedAutomation } from '../ownership/orcad-fenced-automation'
import type { AutomationRunEvent } from '../../../shared/automation-event-triggers'
import { blockedWslDistroForPath } from '../../wsl/filesystem/wsl-unc-access-gate'
import { getLocalProjectWorktreeGitOptions } from '../../workspaces/execution-host/project-runtime-git-options'
import {
  AUTOMATION_RUN_FAILURE_COPY,
  automationRunFailure,
  type AutomationRunFailure
} from '../../../shared/automations/history/automation-run-failure-copy'

export const NO_DISPATCH_HOST = AUTOMATION_RUN_FAILURE_COPY.noDispatchHost
export const WSL_MOVE_IN_PROGRESS = AUTOMATION_RUN_FAILURE_COPY.wslMoveInProgress
export const WSL_MOVE_OWNED_BY_HOST = AUTOMATION_RUN_FAILURE_COPY.wslMoveOwnedByHost
export const MISSED_RUN = AUTOMATION_RUN_FAILURE_COPY.missedGraceWindow

function targetFailure({
  ok: _ok,
  ...failure
}: Extract<AutomationRunTargetResult, { ok: false }>): AutomationRunFailure {
  return failure
}

/** Bot runs launch in main; other runs need a window or the headless dispatcher. */
export function canDispatchTo(
  launchers: { repo: boolean; bot: boolean },
  target: AutomationRunTargetResult
): boolean {
  return target.ok && 'bot' in target ? launchers.bot : launchers.repo
}

/** Decide refusals before creating rows so repeated skips can coalesce. */
export function describeScheduledRefusal(input: {
  target: AutomationRunTargetResult
  canDispatch: boolean
}): AutomationRunFailure | null {
  if (!input.target.ok) {
    return targetFailure(input.target)
  }
  const backoff = 'repo' in input.target ? wslMoveRepoBackoff(input.target.repo) : null
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
    // A bot target has no project runtime; its folder path alone names a UNC distro.
    wslDistro =
      'repo' in target ? getLocalProjectWorktreeGitOptions(store, target.repo).wslDistro : undefined
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

/** How late past grace a run may start: one 60 s tick to reach it and one for jitter. */
const LATE_START_TOLERANCE_MS = 2 * 60 * 1000

/** Whether a run starting now is past grace plus tolerance; the wake gate's own wait never counts. */
export function missedBeyondGrace(input: {
  automation: Automation
  scheduledFor: number
  now: number
  wakeGateDelayMs: number
}): boolean {
  const graceMs = input.automation.missedRunGraceMinutes * 60 * 1000
  const lateMs = input.now - input.wakeGateDelayMs - input.scheduledFor
  return lateMs > graceMs + LATE_START_TOLERANCE_MS
}

/** A missed event folds into the previous missed row, so events missed while Orca was off read as one. */
export async function recordMissedRun(input: {
  runs: AutomationRunWriter
  automation: Automation
  scheduledFor: number
  event?: AutomationRunEvent
}): Promise<AutomationRun> {
  const { runs, automation, scheduledFor, event } = input
  const repeated = event
    ? await runs.repeatSkip(automation.id, MISSED_RUN, scheduledFor, event)
    : null
  if (repeated) {
    return repeated
  }
  const missed = await runs.createRun(
    automation,
    scheduledFor,
    event ? 'event' : 'scheduled',
    event
  )
  if (missed.status !== 'pending') {
    return missed
  }
  return runs.updateRun({
    runId: missed.id,
    status: 'skipped_missed',
    workspaceId: automation.workspaceId,
    ...automationRunFailure('missedGraceWindow')
  })
}
