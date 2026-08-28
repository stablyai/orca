import type { Automation, AutomationRun } from '../../shared/automations-types'
import type { PersistedUIState } from '../../shared/persisted-ui-state-types'
import type { TaskSourceContext, WorkspaceRunContext } from '../../shared/task-source-context'
import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import { hostStableKey, parseHostStableKey } from '../../shared/automation-owner-key'
import { sanitizeSshTargetGeneration } from '../../shared/ssh-target-generation'

/**
 * The automation half of SSH re-adoption (see ssh/ssh-target-readoption.ts).
 *
 * `reassignSshTargetId` re-points repos and worktrees onto the re-added target's
 * id; the same transaction must move every automation-side reference too, or the
 * workspace repairs while its automation stays orphaned on the dead id and the
 * persisted host filter keeps naming a host that no longer exists.
 *
 * The captured generation is rewritten to the re-added registration's rather
 * than left to fail closed: an identity-matched removal tombstone plus a live
 * registration is exactly the positive current-target evidence the design
 * requires, and the value is read from the stored target at migration time — so
 * it can never exceed the allocated high-water mark, and an older incarnation
 * can never be made to look current.
 */

type HostContextCarrier = {
  runContext?: WorkspaceRunContext | null
  sourceContext?: TaskSourceContext | null
}

/** Mutates in place, matching how the Store edits `this.state`. */
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
  /**
   * Records the old target owned through their folder workspace rather than their
   * selector, collected before the workspace sweep re-points the pin. Their
   * capture is the pin's, so re-adoption has to move it with everything else.
   */
  workspacePinnedAutomationIds?: ReadonlySet<string>
  /** The re-added target's current registration generation, read from stored state. */
  newTargetGeneration: number | undefined
}

/** Why: a re-added target with no generation yet must not leave a foreign capture behind — drop it so load-time migration stamps it. */
function rewriteCapturedGeneration(automation: Automation, generation: number | undefined): void {
  if (generation === undefined) {
    delete automation.executionTargetGeneration
  } else {
    automation.executionTargetGeneration = generation
  }
}

/** Re-point stored automations and their run history onto the re-added target. */
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

/** Follow the re-adopted id in the persisted Automations host filter. */
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
  // Why: a target id is unique only inside one authority, so a runtime's identical id is a different host.
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
