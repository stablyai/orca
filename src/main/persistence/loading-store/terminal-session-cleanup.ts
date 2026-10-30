import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import {
  collectTerminalScrollbackSnapshotRefs,
  deleteTerminalScrollbackSnapshotSync,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'

// Exclude local-only scrollback: normalization lacks renderer attribution and would strip valid leaf buffers.
const WORKSPACE_SESSION_PATCH_FULL_NORMALIZATION_KEYS = new Set<keyof WorkspaceSessionState>([
  'tabsByWorktree',
  'terminalLayoutsByTabId'
])

export function workspaceSessionPatchNeedsFullNormalization(patch: WorkspaceSessionPatch): boolean {
  return Object.keys(patch).some((key) =>
    WORKSPACE_SESSION_PATCH_FULL_NORMALIZATION_KEYS.has(key as keyof WorkspaceSessionState)
  )
}

export function deleteRemovedTerminalScrollbackSnapshots(
  prior: WorkspaceSessionState | undefined,
  next: WorkspaceSessionState,
  storage?: TerminalScrollbackSnapshotStorage,
  /** Pending migration exports retain refs even after their session rows disappear. */
  retainedRefs: ReadonlySet<string> = new Set()
): void {
  if (!prior) {
    return
  }
  const nextRefs = collectTerminalScrollbackSnapshotRefs(next)
  for (const ref of collectTerminalScrollbackSnapshotRefs(prior)) {
    if (!nextRefs.has(ref) && !retainedRefs.has(ref)) {
      deleteTerminalScrollbackSnapshotSync(ref, storage)
    }
  }
}
