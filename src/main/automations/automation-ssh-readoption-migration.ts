import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { TaskSourceContext, WorkspaceRunContext } from '../../shared/task-source-context'
import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { hostStableKey, parseHostStableKey } from '../../shared/automation-owner-key'
import { sanitizeSshTargetGeneration } from '../../shared/ssh-target-generation'

// Re-adopt automation references with repos, using the matched registration’s current generation.

type HostContextCarrier = {
  runContext?: WorkspaceRunContext | null
  sourceContext?: TaskSourceContext | null
}

function migrateContextHostIds(
  record: HostContextCarrier,
  oldHostId: string,
  newHostId: ExecutionHostId
): boolean {
  let changed = false
  if (record.runContext?.hostId === oldHostId) {
    record.runContext.hostId = newHostId
    changed = true
  }
  if (record.sourceContext?.hostId === oldHostId) {
    record.sourceContext.hostId = newHostId
    changed = true
  }
  return changed
}

export type AutomationSshReadoptionInput = {
  automations: Automation[]
  automationRuns: AutomationRun[]
  oldTargetId: string
  newTargetId: string
  /** Collect workspace-owned records before re-pointing their pins. */
  workspacePinnedAutomationIds?: ReadonlySet<string>
  newTargetGeneration: number | undefined
}

/** Drop an unknown generation so load-time migration can stamp the new registration. */
function rewriteCapturedGeneration(automation: Automation, generation: number | undefined): void {
  if (generation === undefined) {
    delete automation.executionTargetGeneration
  } else {
    automation.executionTargetGeneration = generation
  }
}

export function migrateAutomationsForSshReadoption(input: AutomationSshReadoptionInput): boolean {
  const oldHostId = toSshExecutionHostId(input.oldTargetId)
  const newHostId = toSshExecutionHostId(input.newTargetId)
  const generation = sanitizeSshTargetGeneration(input.newTargetGeneration)
  let changed = false
  for (const automation of input.automations) {
    if (migrateContextHostIds(automation, oldHostId, newHostId)) {
      changed = true
    }
    if (
      automation.executionTargetType !== 'ssh' ||
      automation.executionTargetId !== input.oldTargetId
    ) {
      // A workspace-pinned record keeps its local selector; only its capture follows the pin.
      if (input.workspacePinnedAutomationIds?.has(automation.id)) {
        rewriteCapturedGeneration(automation, generation)
        changed = true
      }
      continue
    }
    automation.executionTargetId = input.newTargetId
    rewriteCapturedGeneration(automation, generation)
    changed = true
  }
  for (const run of input.automationRuns) {
    if (migrateContextHostIds(run, oldHostId, newHostId)) {
      changed = true
    }
  }
  return changed
}

export function migrateAutomationHostFilterSshTargetId(
  ui: PersistedUIState,
  oldTargetId: string,
  newTargetId: string
): boolean {
  const filter = ui.automationHostFilter
  if (filter?.kind !== 'host') {
    return false
  }
  const host = parseHostStableKey(filter.hostKey)
  // Target IDs are unique only within an authority.
  if (
    host?.authority.kind !== 'desktop' ||
    host.selector.kind !== 'ssh' ||
    host.selector.targetId !== oldTargetId
  ) {
    return false
  }
  ui.automationHostFilter = {
    kind: 'host',
    hostKey: hostStableKey({
      authority: host.authority,
      selector: { kind: 'ssh', targetId: newTargetId }
    })
  }
  return true
}
