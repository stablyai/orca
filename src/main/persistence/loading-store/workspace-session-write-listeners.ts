import type { ExecutionHostId } from '../../../shared/execution-host'
import type { StoreRuntimeState } from './store-runtime-state'

/** Gets the one partition a write changed, or null when any partition may have changed. */
export type WorkspaceSessionWriteListener = (hostId: ExecutionHostId | null) => void

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
