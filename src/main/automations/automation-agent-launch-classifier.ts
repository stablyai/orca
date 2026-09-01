// The resolve-only agent-launch classification seam for automations (U6). Kept
// separate from service.ts so the dispatch orchestrator stays under the line
// budget and the host can back this seam with the shared resolver independently.

import type {
  Automation,
  AutomationDispatchResult,
  AutomationRun
} from '../../shared/automations-types'
import type { AgentLaunchFailure } from '../../shared/agent-launch-contract'
import type { AutomationRunTargetResult } from './run-target-resolution'

/** Resolve-only classification of an automation's agent identity against the
 *  current catalog/settings and its run target. Returns a PLAIN structured
 *  failure for a known bad launch (deleted/disabled custom agent, unbuildable
 *  command, …) or null when the launch would resolve. Never spawns anything —
 *  and never mints the persisted wrapper: the service stamps it at the single
 *  persist point (ledger #12). */
export type AutomationAgentLaunchClassifier = (
  automation: Automation,
  run: AutomationRun,
  target: Extract<AutomationRunTargetResult, { ok: true }>
) => AgentLaunchFailure | null

/** Run the resolve-only classifier and, on a known failure, build the
 *  dispatch_failed result (additive structured failure + a retained generic
 *  `error` string for old readers). Returns null when the launch would resolve,
 *  so the caller proceeds to dispatch. Spawns nothing — the caller persists the
 *  returned result. */
export function classifyAutomationLaunchDispatchFailure(
  classify: AutomationAgentLaunchClassifier | null,
  automation: Automation,
  run: AutomationRun,
  target: Extract<AutomationRunTargetResult, { ok: true }>
): AutomationDispatchResult | null {
  const failure = classify?.(automation, run, target) ?? null
  if (!failure) {
    return null
  }
  return {
    runId: run.id,
    status: 'dispatch_failed',
    workspaceId: automation.workspaceId,
    error: `The automation's agent could not be launched (${failure.code}).`,
    agentLaunchFailure: failure
  }
}
