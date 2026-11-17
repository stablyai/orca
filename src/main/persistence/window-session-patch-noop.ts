import { structuralValuesEqual } from '../../shared/collections/structural-value-equality'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session/workspace-session-state-types'

/**
 * Windows patch every host partition each round, though usually only one host's workspaces changed.
 * A patch whose every field already equals the stored partition's would rebuild the same partition.
 * Comparing with the stored value, not a past write, also sees other writers and time-based rules.
 */
export function isNoopWindowSessionPatch(
  stored: WorkspaceSessionState,
  patch: WorkspaceSessionPatch
): boolean {
  return Object.entries(patch).every(([field, value]) => {
    const storedField = Object.getOwnPropertyDescriptor(stored, field)
    return storedField !== undefined && structuralValuesEqual(storedField.value, value)
  })
}
