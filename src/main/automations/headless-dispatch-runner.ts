import type {
  Automation,
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun
} from '../../shared/automations-types'
import {
  didAutomationPrecheckPass,
  formatAutomationPrecheckFailure
} from '../../shared/automation-precheck'
import type {
  HeadlessAutomationDispatcher,
  HeadlessAutomationDispatchLaunch
} from './headless-dispatch'
import type { AutomationRunTargetResult } from './run-target-resolution'
import type { AutomationRunWriter } from './automation-run-writer'
import type { AutomationRunFailure } from '../../shared/automation-run-failure-copy'

export type HeadlessAutomationDispatchContext = {
  automation: Automation
  run: AutomationRun
  target: Extract<AutomationRunTargetResult, { ok: true }>
  dispatcher: HeadlessAutomationDispatcher
  runs: AutomationRunWriter
  runPrecheck: () => Promise<AutomationPrecheckResult | null>
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
  watchRun: (run: AutomationRun) => void
}

/** Record dispatch refusals as skips. */
export class AutomationDispatchRefusedError extends Error {
  constructor(readonly failure: AutomationRunFailure) {
    super(failure.error)
  }
}

function describeDispatchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function runHeadlessAutomationDispatch(
  ctx: HeadlessAutomationDispatchContext
): Promise<AutomationRun> {
  const { automation, run, target, runs } = ctx
  const precheckResult =
    run.trigger === 'scheduled' && automation.precheck ? await ctx.runPrecheck() : null
  if (precheckResult && !didAutomationPrecheckPass(precheckResult)) {
    return runs.updateRun({
      runId: run.id,
      status: 'skipped_precheck',
      workspaceId: automation.workspaceId,
      precheckResult,
      error: formatAutomationPrecheckFailure(precheckResult)
    })
  }
  let launch: HeadlessAutomationDispatchLaunch
  // The agent can finish before launch returns.
  const dispatchedAt = Date.now()
  try {
    launch = await ctx.dispatcher({ automation, run, target })
  } catch (error) {
    return runs.updateRun({
      runId: run.id,
      status:
        error instanceof AutomationDispatchRefusedError ? 'skipped_unavailable' : 'dispatch_failed',
      workspaceId: automation.workspaceId,
      ...(error instanceof AutomationDispatchRefusedError
        ? error.failure
        : { error: describeDispatchError(error) })
    })
  }
  const launchRunTarget = {
    workspaceId: launch.workspaceId,
    workspaceDisplayName: launch.workspaceDisplayName ?? null,
    terminalSessionId: launch.terminalSessionId,
    terminalPaneKey: launch.terminalPaneKey ?? null,
    terminalPtyId: launch.terminalPtyId ?? null
  }
  const updated = runs.updateRun({
    runId: run.id,
    status: 'dispatched',
    dispatchedAt,
    ...launchRunTarget,
    // Watched completions omit the precheck result.
    ...(precheckResult ? { precheckResult } : {}),
    error: null
  })
  // Start observation without waiting for persistence acknowledgement.
  if (!launch.completion) {
    ctx.watchRun({
      ...run,
      ...launchRunTarget,
      status: 'dispatched',
      dispatchedAt,
      error: null
    })
  } else {
    void launch.completion
      .then(
        (completion) =>
          ctx.markDispatchResult({
            runId: run.id,
            status: completion.status,
            ...launchRunTarget,
            precheckResult,
            outputSnapshot: completion.outputSnapshot ?? null,
            error: completion.error ?? null,
            errorCode: completion.errorCode ?? null,
            errorParams: completion.errorParams ?? null
          }),
        (error) =>
          ctx.markDispatchResult({
            runId: run.id,
            status: 'dispatch_failed',
            ...launchRunTarget,
            error: describeDispatchError(error)
          })
      )
      .catch((error) => console.error('[automations] Failed to persist run completion:', error))
  }
  return updated
}
