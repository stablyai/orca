import { invalidateLocalWorktreeMetadataPruneInputs } from '../../local-worktree-metadata-prune-gate'
import {
  assertAutomationOwnerFence,
  type AutomationOwnerPrecondition
} from '../../../shared/automation-owner-precondition'
import { automationProjectionContext } from './automation-owner-projection'
import type { AutomationDefinitionOperations } from './automation-definition-operations'

export function deleteAutomation(
  operations: AutomationDefinitionOperations,
  id: string,
  options?: { expectedOwner?: AutomationOwnerPrecondition }
): void {
  const automation = (operations.state.automations ?? []).find((entry) => entry.id === id)
  if (automation) {
    assertAutomationOwnerFence({
      automation,
      expectedOwner: options?.expectedOwner,
      operation: 'mutate',
      context: automationProjectionContext(operations.state, operations.storageAuthority, false)
    })
  }
  operations.state.automations = (operations.state.automations ?? []).filter(
    (entry) => entry.id !== id
  )
  operations.state.automationRuns = (operations.state.automationRuns ?? []).filter(
    (entry) => entry.automationId !== id
  )
  operations.recordAutomationRunsMutation?.(operations.state.automationRuns)
  // Removing definitions and unfinished runs releases their workspace claims (#17775).
  invalidateLocalWorktreeMetadataPruneInputs()
  operations.flush()
}
