import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/workspace-layout/layout-owner-switch'
import type { StoreRuntimeState } from '../store-runtime-state'
import { refileEditorViews } from './layout-editor-views'
import { WORKSPACE_SESSION_DOMAINS } from '../../workspace-session-domains'

/** Null means any partition may have changed; absent workspaces mean any workspace of that partition. */
export type WorkspaceSessionWriteListener = (
  hostId: ExecutionHostId | null,
  workspaces?: ReadonlySet<string>
) => void

/** Null means any partition may have changed. */
export type WorkspaceSessionOperationListener = (hostIds: readonly ExecutionHostId[] | null) => void

/** Full saves may contain untracked session edits; an absent host makes all partitions candidates. */
export function notifyWorkspaceSessionWritten(
  runtime: Pick<
    StoreRuntimeState,
    'workspaceSessionWriteListeners' | 'layoutEditorViews' | 'state'
  >,
  dirtyDomains?: readonly string[],
  hostId?: ExecutionHostId,
  workspaces?: ReadonlySet<string>
): void {
  if (
    dirtyDomains &&
    !dirtyDomains.some((domain) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: widening domain literals permits checking any dirty-domain string.
      (WORKSPACE_SESSION_DOMAINS as readonly string[]).includes(domain)
    )
  ) {
    return
  }
  // Refile views before listeners project the updated session.
  const refiled = refileEditorViews(runtime)
  // A refiled view can move between any of the partition's workspaces.
  const written = hostId === undefined || refiled.has(hostId) ? undefined : workspaces
  for (const listener of runtime.workspaceSessionWriteListeners) {
    listener(hostId ?? null, written)
  }
}

/** Main-owned layouts report each declared partition before announcing mutation completion. */
export function notifyWorkspaceSessionOperationEnded(
  runtime: Pick<
    StoreRuntimeState,
    | 'workspaceSessionWriteListeners'
    | 'workspaceSessionOperationListeners'
    | 'layoutEditorViews'
    | 'state'
  >,
  hostIds: readonly ExecutionHostId[] | null,
  workspaces?: ReadonlyMap<ExecutionHostId, ReadonlySet<string>>
): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    notifyWorkspaceSessionWritten(runtime)
    return
  }
  if (hostIds === null) {
    notifyWorkspaceSessionWritten(runtime)
  }
  for (const hostId of hostIds ?? []) {
    notifyWorkspaceSessionWritten(runtime, undefined, hostId, workspaces?.get(hostId))
  }
  for (const listener of runtime.workspaceSessionOperationListeners) {
    // Committed writes must survive a failed observer and still notify the remaining observers.
    try {
      listener(hostIds)
    } catch (error) {
      console.warn('[persistence] workspace-session operation listener failed:', error)
    }
  }
}
