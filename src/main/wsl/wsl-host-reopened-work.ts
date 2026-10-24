import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

type SessionReader = { getWorkspaceSession(hostId?: string | null): WorkspaceSessionState }

/**
 * The WSL hosts the saved session reopens with open work: the active workspace's host, and every
 * host whose session partition still has a terminal tab. The renderer reports the same set once it
 * hydrates; reading it at launch lets the distro boot overlap the app's own startup.
 */
export function wslHostsWithReopenedWork(
  store: SessionReader,
  environmentIds: readonly string[]
): string[] {
  const active = store.getWorkspaceSession(null).activeWorkspaceExecutionHostId
  return environmentIds.filter((environmentId) => {
    const hostId = toRuntimeExecutionHostId(environmentId)
    if (active === hostId) {
      return true
    }
    const { tabsByWorktree } = store.getWorkspaceSession(hostId)
    return Object.values(tabsByWorktree).some((tabs) => tabs.length > 0)
  })
}
