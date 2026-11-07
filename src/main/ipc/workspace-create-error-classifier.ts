// Emit only error-class enums, never interpolated paths or branch names; keep reviewed matches narrow and unknown otherwise.

import type { WorkspaceCreateErrorClass } from '../../shared/telemetry-events'

export function classifyWorkspaceCreateError(error: unknown): WorkspaceCreateErrorClass {
  const text = (error instanceof Error ? error.message : '').toLowerCase()

  if (text.includes('could not resolve a default base ref')) {
    return 'base_ref_missing'
  }
  if (
    text.includes('already exists locally') ||
    text.includes('already exists on a remote') ||
    text.includes('already exists. pick') ||
    text.includes('already has pr') ||
    text.includes('could not find an available worktree name')
  ) {
    return 'path_collision'
  }
  if (text.includes('eacces') || text.includes('eperm') || text.includes('permission denied')) {
    return 'permission_denied'
  }
  // Specific Git anchors exclude SSH connectivity and sparse-validation failures, which remain unknown.
  if (
    text.includes('fatal:') ||
    text.includes('git worktree') ||
    text.includes('created but not found in listing')
  ) {
    return 'git_failed'
  }
  return 'unknown'
}
