import type { StoreRuntimeState } from './store-runtime-state'

const WORKSPACE_SESSION_DOMAINS: readonly string[] = [
  'workspaceSession',
  'workspaceSessionsByHostId'
]

/** `dirtyDomains` undefined means a full save, which may carry an in-place session edit. */
export function notifyWorkspaceSessionWritten(
  runtime: Pick<StoreRuntimeState, 'workspaceSessionWriteListeners'>,
  dirtyDomains?: readonly string[]
): void {
  if (dirtyDomains && !dirtyDomains.some((domain) => WORKSPACE_SESSION_DOMAINS.includes(domain))) {
    return
  }
  for (const listener of runtime.workspaceSessionWriteListeners) {
    listener()
  }
}
