import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'

function deepFreeze(value: unknown): void {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return
  }
  Object.freeze(value)
  for (const child of Object.values(value)) {
    deepFreeze(child)
  }
}

/**
 * Rollback keeps the previous and published sessions by reference, so published sessions are
 * replaced, never edited. Under Vitest they are frozen so an in-place edit throws.
 */
export function freezePublishedWorkspaceSession(session: WorkspaceSessionState): void {
  if (process.env.VITEST) {
    deepFreeze(session)
  }
}
