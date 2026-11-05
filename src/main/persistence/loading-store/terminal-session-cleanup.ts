import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session/workspace-session-state-types'
import {
  collectTerminalScrollbackSnapshotRefs,
  deleteTerminalScrollbackSnapshotSync,
  type TerminalScrollbackSnapshotStorage
} from '../../pty/scrollback/terminal-scrollback-snapshots'
import type { StoreRuntimeState } from './store-runtime-state'

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
  retainedRefs: ReadonlySet<string> = new Set(),
  deferredDeletions: Set<string> | null = null
): void {
  if (!prior) {
    return
  }
  const nextRefs = collectTerminalScrollbackSnapshotRefs(next)
  for (const ref of collectTerminalScrollbackSnapshotRefs(prior)) {
    if (!nextRefs.has(ref)) {
      // A migration can release its hold before this mutation settles.
      if (deferredDeletions) {
        deferredDeletions.add(ref)
      } else if (!retainedRefs.has(ref)) {
        deleteTerminalScrollbackSnapshotSync(ref, storage)
      }
    }
  }
}

/** A refused mutation may restore these refs; release files only after its compensation settles. */
export function finishMutationScrollbackDeletions(
  runtime: Pick<
    StoreRuntimeState,
    | 'deferredMutationScrollbackDeletions'
    | 'state'
    | 'terminalScrollbackSnapshotStorage'
    | 'retainedScrollbackRefsByMigrationId'
  >
): void {
  const deferred = runtime.deferredMutationScrollbackDeletions
  runtime.deferredMutationScrollbackDeletions = null
  if (!deferred?.size) {
    return
  }
  const sessions = [
    runtime.state.workspaceSession,
    ...Object.values(runtime.state.workspaceSessionsByHostId ?? {})
  ]
  const retained = new Set([
    ...sessions.flatMap((session) =>
      session ? [...collectTerminalScrollbackSnapshotRefs(session)] : []
    ),
    ...[...runtime.retainedScrollbackRefsByMigrationId.values()].flatMap((refs) => [...refs])
  ])
  for (const ref of deferred) {
    if (!retained.has(ref)) {
      deleteTerminalScrollbackSnapshotSync(ref, runtime.terminalScrollbackSnapshotStorage)
    }
  }
}
