import type { Store } from './loading-store/store'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import { parseAppSshPtyId } from '../../shared/remote-runtime/ssh/ssh-pty-id'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { workspaceSessionPartitionHostId } from '../../shared/workspace-session/workspace-session-partition-owner'
import type { LegacyRelayAdoption } from '../../shared/workspace-session/desktop-relay-ownership'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'

type AdoptionStore = Pick<Store, 'getRepos' | 'getWorkspaceSession' | 'getWorkspaceSessionHostIds'>

/** Where each tab row lives when it is in exactly one partition, under a worktree of an SSH repo the
 *  window saves (repo worktrees whose repo has a connection, as the window's session builder writes). */
function uniqueSshRepoTabHosts(store: AdoptionStore): Map<string, ExecutionHostId> {
  const repoById = new Map(store.getRepos().map((repo) => [repo.id, repo]))
  const hostByTab = new Map<string, ExecutionHostId | null>()
  for (const hostId of store.getWorkspaceSessionHostIds()) {
    for (const [worktreeId, tabs] of Object.entries(
      store.getWorkspaceSession(hostId).tabsByWorktree ?? {}
    )) {
      const repo = repoById.get(getRepoIdFromWorktreeId(worktreeId))
      const owner = repo?.connectionId
        ? workspaceSessionPartitionHostId(getRepoExecutionHostId(repo))
        : null
      for (const tab of tabs) {
        const seen = hostByTab.get(tab.id)
        // A row in two partitions, or under a host that isn't its repo's, is ambiguous.
        hostByTab.set(tab.id, seen === undefined && owner === hostId ? owner : null)
      }
    }
  }
  const unique = new Map<string, ExecutionHostId>()
  for (const [tabId, hostId] of hostByTab) {
    if (hostId) {
      unique.set(tabId, hostId)
    }
  }
  return unique
}

/** Relay ids saved before ownership was recorded that the window wrote: those of SSH repo tabs whose
 *  row is uniquely attributable, in the row's partition or (an older build's split) another partition
 *  holding the same id or the only copy. Folder, ambiguous and unattributable entries stay main's. */
export function desktopRelayLegacyAdoption(
  store: AdoptionStore,
  hostId: ExecutionHostId
): LegacyRelayAdoption {
  return (session: WorkspaceSessionState) => {
    const saved = session.remoteSessionIdsByTabId
    if (!saved || Object.keys(saved).length === 0) {
      return {}
    }
    const tabHosts = uniqueSshRepoTabHosts(store)
    const adopted: Record<string, string> = {}
    for (const [tabId, relayId] of Object.entries(saved)) {
      const rowHost = tabHosts.get(tabId)
      if (!rowHost || !parseAppSshPtyId(relayId)) {
        continue
      }
      const rowCopy =
        rowHost === hostId
          ? relayId
          : store.getWorkspaceSession(rowHost).remoteSessionIdsByTabId?.[tabId]
      if (rowCopy === undefined || rowCopy === relayId) {
        adopted[tabId] = relayId
      }
    }
    return adopted
  }
}
