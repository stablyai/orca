import type { ExecutionHostId } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { StoreRuntimeState } from './store-runtime-state'

/** Gets the one partition a write changed, or null when any partition may have changed. */
export type WorkspaceSessionWriteListener = (hostId: ExecutionHostId | null) => void

/** Gets the partitions one durable mutation may have written, or null when any may have changed. */
export type WorkspaceSessionOperationListener = (hostIds: readonly ExecutionHostId[] | null) => void

const WORKSPACE_SESSION_DOMAINS: readonly string[] = [
  'workspaceSession',
  'workspaceSessionsByHostId'
]

/**
 * `dirtyDomains` undefined means a full save, which may carry an in-place session edit.
 * `hostId` names the only partition the write changed; without it every partition is suspect.
 */
export function notifyWorkspaceSessionWritten(
  runtime: Pick<StoreRuntimeState, 'workspaceSessionWriteListeners'>,
  dirtyDomains?: readonly string[],
  hostId?: ExecutionHostId
): void {
  if (dirtyDomains && !dirtyDomains.some((domain) => WORKSPACE_SESSION_DOMAINS.includes(domain))) {
    return
  }
  for (const listener of runtime.workspaceSessionWriteListeners) {
    listener(hostId ?? null)
  }
}

/**
 * A durable mutation's end. Switch point: a layout-owner build names the partitions the mutation
 * declared, then tells operation listeners its writes are all in; others notify as any write.
 */
export function notifyWorkspaceSessionOperationEnded(
  runtime: Pick<
    StoreRuntimeState,
    'workspaceSessionWriteListeners' | 'workspaceSessionOperationListeners'
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
    // The operation already committed: a reader's throw must not fail it or the next reader.
    try {
      listener(hostIds)
    } catch (error) {
      console.warn('[persistence] workspace-session operation listener failed:', error)
    }
  }
}
