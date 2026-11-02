import type { Automation, AutomationUpdateInput } from '../../../shared/automations-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  AUTOMATION_ORPHAN_ISSUES,
  projectAutomationSelector,
  type AutomationProjectionContext
} from '../../../shared/automation-list-scope'
import type { AutomationDestination } from '../../../shared/automation-owner-precondition'
import {
  AUTOMATION_OWNER_CONFLICT_CODES,
  AutomationOwnerConflictError
} from '../../../shared/automation-owner-conflict'
import { findAutomationRepo } from '../../../shared/automation-repo-target'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { areTaskSourceContextsEqual } from '../../../shared/task-source-context'

/** Verify the original physical target in the same transaction that adopts its registration. */
export function retainAutomationReselectionContexts(
  state: PersistedState,
  current: Automation,
  updates: AutomationUpdateInput,
  destination: AutomationDestination | undefined,
  projection: AutomationProjectionContext
): boolean {
  const selector = projectAutomationSelector(current, projection)
  const context = current.runContext
  if (
    !destination ||
    !context ||
    selector.kind !== 'orphan' ||
    selector.issue !== AUTOMATION_ORPHAN_ISSUES.hostReselection
  ) {
    return false
  }
  const proposed = updates.runContext ?? context
  const sameContext =
    updates.runContext !== null &&
    (['kind', 'projectId', 'hostId', 'projectHostSetupId', 'repoId', 'path'] as const).every(
      (key) => proposed[key] === context[key]
    )
  if (
    !sameContext ||
    (updates.sourceContext !== undefined &&
      (updates.sourceContext === null
        ? current.sourceContext !== null
        : !areTaskSourceContextsEqual(updates.sourceContext, current.sourceContext))) ||
    (updates.projectId ?? current.projectId) !== current.projectId ||
    (updates.workspaceMode ?? current.workspaceMode) !== current.workspaceMode ||
    (updates.workspaceId !== undefined && updates.workspaceId !== current.workspaceId)
  ) {
    return false
  }
  const host = parseExecutionHostId(context.hostId)
  const repo = findAutomationRepo(state.repos, context.repoId, context)
  const setups = (state.projectHostSetups ?? []).filter(
    (setup) => setup.id === context.projectHostSetupId && setup.hostId === context.hostId
  )
  const setup = setups.length === 1 ? setups[0] : undefined
  // Logical project IDs can evolve; repo, host, saved setup ID and path are the stable identity.
  if (
    !repo ||
    !setup ||
    setup.repoId !== context.repoId ||
    setup.path !== context.path ||
    host?.kind !== 'ssh' ||
    destination.selector.kind !== 'ssh' ||
    destination.selector.targetId !== host.targetId
  ) {
    throw new AutomationOwnerConflictError(AUTOMATION_OWNER_CONFLICT_CODES.invalidDestination)
  }
  return true
}
