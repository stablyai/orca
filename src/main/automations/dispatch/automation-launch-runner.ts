import type { Automation } from '../../../shared/automations/automation-definition'
import type {
  AutomationDispatchResult,
  AutomationPrecheckResult,
  AutomationRun
} from '../../../shared/automations/history/automation-run'
import {
  didAutomationPrecheckPass,
  formatAutomationPrecheckFailure
} from '../../../shared/automations/launch/automation-precheck'
import type { AutomationLauncher, AutomationLaunch } from '../launch/automation-launch'
import { AutomationRunLaunchError } from '../launch/automation-launch'
import type { AutomationRunTargetResult } from '../ownership/run-target-resolution'
import {
  automationRunFailure,
  type AutomationRunFailure
} from '../../../shared/automations/history/automation-run-failure-copy'
import { parseWslDistroHold } from '../../../shared/wsl-distro-stopped-hold'

export type AutomationLaunchContext = {
  automation: Automation
  run: AutomationRun
  target: Extract<AutomationRunTargetResult, { ok: true }>
  dispatcher: AutomationLauncher
  /** Write only while this dispatch still owns a dispatching run; throws AutomationDispatchCancelledError once the service or automation is gone. */
  transition: (result: Omit<AutomationDispatchResult, 'runId'>) => {
    applied: boolean
    run: Promise<AutomationRun>
  }
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

/** A launch the runtime held for a stopped WSL distro is a retryable skip, not a crash (E9). */
function heldForStoppedWslDistro(error: unknown): AutomationRunFailure | null {
  const hold = parseWslDistroHold(describeDispatchError(error))
  return hold ? automationRunFailure('wslDistroStopped', { distro: hold.distro }) : null
}

export async function runAutomationLaunch(ctx: AutomationLaunchContext): Promise<AutomationRun> {
  const { automation, run, target } = ctx
  const precheckResult =
    run.trigger === 'scheduled' && automation.precheck ? await ctx.runPrecheck() : null
  if (precheckResult && !didAutomationPrecheckPass(precheckResult)) {
    return ctx.transition({
      status: 'skipped_precheck',
      workspaceId: automation.workspaceId,
      precheckResult,
      error: formatAutomationPrecheckFailure(precheckResult)
    }).run
  }
  let launch: AutomationLaunch
  // The agent can finish before launch returns.
  const dispatchedAt = Date.now()
  try {
    launch = await ctx.dispatcher({ automation, run, target })
  } catch (error) {
    const refusal =
      error instanceof AutomationDispatchRefusedError
        ? error.failure
        : heldForStoppedWslDistro(error)
    return ctx.transition({
      status: refusal ? 'skipped_unavailable' : 'dispatch_failed',
      workspaceId: automation.workspaceId,
      ...(error instanceof AutomationRunLaunchError ? error.target : {}),
      // A partial start produced the agent's terminal or session before failing, so it
      // counts as launched at the dispatch-start time.
      ...(error instanceof AutomationRunLaunchError && openedAgent(error.target)
        ? { launchedAt: dispatchedAt }
        : {}),
      ...(automation.surface === 'chat' ? { dispatchedAt, precheckResult } : {}),
      ...(refusal ?? { error: describeDispatchError(error) })
    }).run
  }
  const launchRunTarget = launchRunTargetOf(launch)
  if (launch.delivery) {
    // A startup dialog can hold delivery, so link the terminal while the run is still dispatching.
    const linked = ctx.transition({
      status: 'dispatching',
      ...launchRunTarget,
      launchedAt: dispatchedAt
    })
    if (!linked.applied) {
      return linked.run
    }
    linked.run.catch((error: unknown) => {
      console.warn('[automations] failed to record the opened run terminal:', error)
    })
    const { error } = await launch.delivery
    if (error !== null) {
      return ctx.transition({
        status: 'dispatch_failed',
        ...launchRunTarget,
        launchedAt: dispatchedAt,
        error
      }).run
    }
  }
  const updated = ctx.transition({
    status: 'dispatched',
    dispatchedAt,
    launchedAt: dispatchedAt,
    ...launchRunTarget,
    // Watched completions omit the precheck result.
    ...(precheckResult ? { precheckResult } : {}),
    ...(launch.setupSkippedReason ? { setupSkippedReason: launch.setupSkippedReason } : {}),
    ...(launch.setupSkippedContent ? { setupSkippedContent: launch.setupSkippedContent } : {}),
    error: null
  })
  if (!updated.applied) {
    return updated.run
  }
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
  return updated.run
}

/** The launch got as far as producing the agent's terminal or chat session. */
function openedAgent(target: AutomationLaunch | undefined): boolean {
  return Boolean(
    target && (target.terminalPaneKey || target.terminalSessionId || target.chatSessionId)
  )
}

function launchRunTargetOf(launch: AutomationLaunch) {
  return {
    sessionKind: launch.sessionKind ?? 'terminal',
    chatSessionId: launch.chatSessionId ?? null,
    workspaceId: launch.workspaceId,
    workspaceDisplayName: launch.workspaceDisplayName ?? null,
    terminalSessionId: launch.terminalSessionId,
    terminalPaneKey: launch.terminalPaneKey ?? null,
    terminalPtyId: launch.terminalPtyId ?? null
  }
}
