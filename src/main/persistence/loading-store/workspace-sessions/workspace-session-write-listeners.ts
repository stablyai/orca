import type { ExecutionHostId } from '../../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import type { StoreRuntimeState } from '../store-runtime-state'
import { refileEditorViews } from './layout-editor-views'
import { WORKSPACE_SESSION_DOMAINS } from '../../workspace-session-domains'

/** Null means any partition may have changed. */
export type WorkspaceSessionWriteListener = (hostId: ExecutionHostId | null) => void

/** Null means any partition may have changed. */
export type WorkspaceSessionOperationListener = (hostIds: readonly ExecutionHostId[] | null) => void

/** Full saves may contain untracked session edits; an absent host makes all partitions candidates. */
export function notifyWorkspaceSessionWritten(
  runtime: Pick<
    StoreRuntimeState,
    'workspaceSessionWriteListeners' | 'layoutEditorViews' | 'state'
  >,
  dirtyDomains?: readonly string[],
  hostId?: ExecutionHostId
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
  refileEditorViews(runtime)
  for (const listener of runtime.workspaceSessionWriteListeners) {
    listener(hostId ?? null)
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
  hostIds: readonly ExecutionHostId[] | null
): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    notifyWorkspaceSessionWritten(runtime)
    return
  }
  if (hostIds === null) {
    notifyWorkspaceSessionWritten(runtime)
  }
  for (const hostId of hostIds ?? []) {
    notifyWorkspaceSessionWritten(runtime, undefined, hostId)
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
