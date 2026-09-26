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
import type { HeadlessAutomationDispatcher } from './headless-dispatch'
import type { AutomationRunTargetResult } from './run-target-resolution'
import type { AutomationRunWriter } from './automation-run-writer'

export type HeadlessAutomationDispatchContext = {
  automation: Automation
  run: AutomationRun
  target: Extract<AutomationRunTargetResult, { ok: true }>
  dispatcher: HeadlessAutomationDispatcher
  beginHeadlessCompletionAbort: (runId: string) => AbortController
  runs: AutomationRunWriter
  runPrecheck: () => Promise<AutomationPrecheckResult | null>
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
  watchRun: (run: AutomationRun) => void
}

function describeDispatchError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function shouldIgnoreHeadlessCompletion(
  error: unknown,
  abortSignal: AbortSignal | undefined
): boolean {
  if (abortSignal?.aborted) {
    return true
  }
  return error instanceof Error && error.message === 'request_aborted'
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
  try {
    const completionAbort = ctx.beginHeadlessCompletionAbort(run.id)
    const launch = await ctx.dispatcher({
      automation,
      run,
      target,
      completionSignal: completionAbort.signal
    })
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
      ...launchRunTarget,
      error: null
    })
    if (!launch.completion) {
      // Why: a dispatcher that reports no completion promise would otherwise
      // leave the run at 'dispatched' for the process lifetime.
      ctx.watchRun(updated)
      return updated
    }
    const completionAbortSignal = launch.completionAbortSignal
    void launch.completion
      .then((completion) => {
        if (completionAbortSignal?.aborted) {
          return
        }
        return ctx.markDispatchResult({
          runId: run.id,
          status: completion.status,
          ...launchRunTarget,
          precheckResult,
          outputSnapshot: completion.outputSnapshot ?? null,
          error: completion.error ?? null
        })
      })
      .catch((error) => {
        if (shouldIgnoreHeadlessCompletion(error, completionAbortSignal)) {
          return
        }
        return ctx.markDispatchResult({
          runId: run.id,
          status: 'dispatch_failed',
          ...launchRunTarget,
          error: describeDispatchError(error)
        })
      })
    return updated
  } catch (error) {
    return runs.updateRun({
      runId: run.id,
      status: 'dispatch_failed',
      workspaceId: automation.workspaceId,
      error: describeDispatchError(error)
    })
  }
}
