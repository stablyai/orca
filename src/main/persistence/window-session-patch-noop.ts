import { structuralValuesEqual } from '../../shared/collections/structural-value-equality'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session/workspace-session-state-types'

/** Comparing with the stored partition, not a past write, also sees other writers and timed rules. */
export function isNoopWindowSessionPatch(
  stored: WorkspaceSessionState,
  patch: WorkspaceSessionPatch
): boolean {
  return Object.entries(patch).every(([field, value]) => {
    const storedField = Object.getOwnPropertyDescriptor(stored, field)
    return storedField !== undefined && structuralValuesEqual(storedField.value, value)
  })
}
