/**
 * What the owning authority says, and writes, when it refuses to start a run.
 *
 * Kept together because every refusal must be one fixed sentence: skip
 * coalescing folds repeats only on byte-identical text, so a reason that varied
 * per occurrence would write a row each.
 */
import type { WebContents } from 'electron'
import type { Store } from '../persistence'
import type {
  Automation,
  AutomationDispatchRequest,
  AutomationRun
} from '../../shared/automations-types'
import { resolveAutomationRunTarget, type AutomationRunTargetResult } from './run-target-resolution'
import type { AutomationRunWriter } from './automation-run-writer'

export const NO_DISPATCH_HOST = 'No Orca window was available to launch the automation.'

/** A record the tick could not evaluate at all — its schedule no longer resolves (#16303). */
export const UNEVALUABLE_SCHEDULE =
  'Orca could not evaluate this automation and skipped the occurrence.'

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

/**
 * Marks the poison record the scheduler tick just stepped over, so the user sees why it
 * stalled. Folds on the fixed sentence and the unchanged nextRunAt, so a record that stays
 * broken writes one row rather than one per tick, and never throws back into the tick.
 */
export async function recordUnevaluableAutomation(input: {
  runs: AutomationRunWriter
  automation: Automation
  error: unknown
}): Promise<void> {
  const { automation } = input
  try {
    // nextRunAt deliberately stays put: the record is retried so a repaired schedule resumes
    // on its own. The fold is what keeps that from writing a row — and logging — every tick.
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
    // The original failure has not been reported yet on this path, so carry it too.
    console.error(
      '[automations] failed to record unevaluable automation:',
      automation.id,
      input.error,
      writeError
    )
  }
}

/**
 * Sends the dispatch request through the renderer channel, closing the run out as
 * `dispatch_failed` when the send throws — a failed send is not an unreadable schedule.
 */
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

/**
 * Grace is a downtime catch-up budget. It must not also absorb the scheduler's own tick latency:
 * evaluation runs on a fixed interval never aligned to an occurrence, so with zero grace every
 * tick arrived "late" and skipped the run, blaming downtime that never happened (#11299).
 *
 * Why not process liveness: a suspended process (system sleep) keeps its start time, so a
 * liveness flag waves through an occurrence that came due during a multi-hour sleep -- exactly
 * what grace exists for. Elapsed lateness cannot be faked that way.
 *
 * Consequence worth knowing: elapsed lateness cannot distinguish a short outage from a late
 * tick, so a zero-grace run that came due during an outage shorter than the tolerance is
 * dispatched rather than skipped. That is the deliberate trade -- the alternative was a
 * liveness flag, which got the far worse case wrong (a multi-hour sleep replayed on wake).
 *
 * Known remaining gap: an evaluation pass holds the re-entrancy guard across its dispatches, and
 * in serve mode a dispatch runs inline (precheck up to 600s, then a worktree create). A pass
 * longer than the tolerance drops every intervening tick, so the next automation's lateness is
 * the scheduler's stall rather than downtime and can still be mis-skipped. Desktop is
 * unaffected -- its dispatch is synchronous IPC. Tracked separately; forgiving "time since the
 * last pass" is NOT the fix, because a suspended process runs no passes either.
 */
export function missedBeyondGrace(input: {
  automation: Automation
  scheduledFor: number
  now: number
  tickMs: number
}): boolean {
  const graceMs = input.automation.missedRunGraceMinutes * 60 * 1000
  // Two intervals: one for the tick that should have caught it, one for ordinary jitter.
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
