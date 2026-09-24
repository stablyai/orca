import type { Automation, AutomationUpdateInput } from '../../shared/automations-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { resolveWorkerLaunchPreferences } from './rpc/methods/orchestration/worker/worker-launch-preferences'
import { hasRuntimeAutomationUpdateValue } from './runtime-automation-update-value'
import type { RuntimeAutomationUpdateInput } from './runtime-automation-controller'

type ResolvedAutomationLaunchPin = { model: string | null; effort: string | null }

/**
 * Validates a pinned model exactly as `orchestration worker-start` does, so an
 * agent with no launch catalog is refused while the automation is being written
 * rather than launching at 3am on whatever default the host happens to hold.
 */
export function resolveAutomationLaunchPin(
  agent: TuiAgent,
  model: string | null | undefined,
  effort: string | null | undefined
): ResolvedAutomationLaunchPin {
  const { preferences } = resolveWorkerLaunchPreferences({
    agent,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  })
  return { model: preferences?.model ?? null, effort: preferences?.effort ?? null }
}

/**
 * Rewrites the pin fields of an update patch once the agent, model, or effort is
 * being changed. Why the merge: an edit that touches only one of the three still
 * has to be checked against the other two as they will stand once it lands.
 */
export function applyAutomationLaunchPinPatch(
  current: Automation,
  updates: RuntimeAutomationUpdateInput,
  patch: AutomationUpdateInput
): void {
  if (
    !hasRuntimeAutomationUpdateValue(updates, 'agentId') &&
    !hasRuntimeAutomationUpdateValue(updates, 'model') &&
    !hasRuntimeAutomationUpdateValue(updates, 'effort')
  ) {
    return
  }
  const model = patch.model === undefined ? current.model : patch.model
  const pin = resolveAutomationLaunchPin(
    patch.agentId ?? current.agentId,
    model,
    // Why the patch's own model and not the merged one: only an explicit `--model null`
    // unpins, and it takes the effort with it. A record that is merely already unpinned
    // must still reject an effort, exactly as create does.
    patch.model === null ? null : patch.effort === undefined ? current.effort : patch.effort
  )
  patch.model = pin.model
  patch.effort = pin.effort
}
