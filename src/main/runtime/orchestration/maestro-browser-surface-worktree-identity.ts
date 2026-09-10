import { parseWorkspaceKey, worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { OrchestrationError } from './orchestration-error'

// Why: the runtime keys browser panes by a raw worktree id while Maestro anchors carry a
// `worktree:`-prefixed workspace key. This module is the only place that converts between the
// two, so no caller emits `id:worktree:<id>` or compares a raw id against a prefixed key.

export function browserSurfaceWorktreeId(workspaceKey: string): string {
  const scope = parseWorkspaceKey(workspaceKey)
  if (scope?.type === 'worktree') {
    return scope.worktreeId
  }
  throw new OrchestrationError(
    'browser_surface_workspace_unsupported',
    scope
      ? `Folder workspace ${workspaceKey} has no worktree-scoped native Browser pane.`
      : `Workspace key ${workspaceKey} is not a parseable workspace key.`
  )
}

export function browserSurfaceWorktreeSelector(workspaceKey: string): string {
  return `id:${browserSurfaceWorktreeId(workspaceKey)}`
}

/** Lifts an observed tab's raw worktree id back into the workspace-key vocabulary receipts use. */
export function browserSurfaceObservedWorkspaceKey(
  observedWorktreeId: string | null | undefined,
  reservedWorkspaceKey: string
): string {
  return observedWorktreeId ? worktreeWorkspaceKey(observedWorktreeId) : reservedWorkspaceKey
}
