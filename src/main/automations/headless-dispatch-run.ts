// The headless (no-renderer) automation dispatch flow, extracted from service.ts
// so the orchestrator stays under the line budget. Precheck → launch via the
// injected headless dispatcher → persist dispatched/dispatch_failed, wiring the
// launch's completion promise back through markDispatchResult.

import type { Store } from '../persistence'
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
import type { AutomationRunTargetResult } from './run-target-resolution'
import type { HeadlessAutomationDispatcher } from './headless-dispatch'

export type HeadlessAutomationDispatchDeps = {
  store: Store
  headlessDispatcher: HeadlessAutomationDispatcher
  runPrecheck: (automationId: string, runId: string) => Promise<AutomationPrecheckResult | null>
  markDispatchResult: (result: AutomationDispatchResult) => Promise<AutomationRun>
}

export async function runHeadlessAutomationDispatch(
  deps: HeadlessAutomationDispatchDeps,
  automation: Automation,
  run: AutomationRun,
  target: Extract<AutomationRunTargetResult, { ok: true }>
): Promise<AutomationRun> {
  const precheckResult =
    run.trigger === 'scheduled' && automation.precheck
      ? await deps.runPrecheck(automation.id, run.id)
      : null
  if (precheckResult && !didAutomationPrecheckPass(precheckResult)) {
    return deps.store.updateAutomationRun({
      runId: run.id,
      status: 'skipped_precheck',
      workspaceId: automation.workspaceId,
      precheckResult,
      error: formatAutomationPrecheckFailure(precheckResult)
    })
  }
  try {
    const launch = await deps.headlessDispatcher({ automation, run, target })
    const launchRunTarget = {
      workspaceId: launch.workspaceId,
      workspaceDisplayName: launch.workspaceDisplayName ?? null,
      terminalSessionId: launch.terminalSessionId,
      terminalPaneKey: launch.terminalPaneKey ?? null,
      terminalPtyId: launch.terminalPtyId ?? null
    }
    const updated = deps.store.updateAutomationRun({
      runId: run.id,
      status: 'dispatched',
      ...launchRunTarget,
      error: null
    })
    if (launch.completion) {
      void launch.completion
        .then((completion) =>
          deps.markDispatchResult({
            runId: run.id,
            status: completion.status,
            ...launchRunTarget,
            precheckResult,
            outputSnapshot: completion.outputSnapshot ?? null,
            error: completion.error ?? null
          })
        )
        .catch((error) =>
          deps.markDispatchResult({
            runId: run.id,
            status: 'dispatch_failed',
            ...launchRunTarget,
            error: error instanceof Error ? error.message : String(error)
          })
        )
    }
    return updated
  } catch (error) {
    return deps.store.updateAutomationRun({
      runId: run.id,
      status: 'dispatch_failed',
      workspaceId: automation.workspaceId,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
