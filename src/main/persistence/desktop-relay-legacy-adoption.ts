import type { Store } from './loading-store/store'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import { parseAppSshPtyId } from '../../shared/remote-runtime/ssh/ssh-pty-id'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { workspaceSessionPartitionHostId } from '../../shared/workspace-session/workspace-session-partition-owner'
import {
  DESKTOP_RELAY_LEGACY_ADOPTION_VERSION,
  type LegacyRelayAdoption
} from '../../shared/workspace-session/desktop-relay-ownership'

type AdoptionStore = Pick<Store, 'getRepos' | 'getWorkspaceSession' | 'getWorkspaceSessionHostIds'>

/** Relay ids saved before ownership was recorded, read once before any window or main writer runs, so
 *  an id main writes later is never mistaken for one an older build's window wrote. */
export type LegacyRelayBaseline = Map<ExecutionHostId, Record<string, string>>

export function captureLegacyRelayBaseline(store: AdoptionStore): LegacyRelayBaseline {
  const baseline: LegacyRelayBaseline = new Map()
  for (const hostId of store.getWorkspaceSessionHostIds()) {
    const session = store.getWorkspaceSession(hostId)
    const adopted =
      (session.desktopRelayAdoptionVersion ?? 0) >= DESKTOP_RELAY_LEGACY_ADOPTION_VERSION
    const saved = session.remoteSessionIdsByTabId
    if (!adopted && saved && Object.keys(saved).length > 0) {
      baseline.set(hostId, { ...saved })
    }
  }
  return baseline
}

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

/** One apply batch's adoption: the fleet's tab rows are indexed at most once, against the partitions as
 *  they were when the batch began. An id is adopted when it still equals its pre-upgrade value and
 *  belongs to an SSH repo tab whose row is uniquely attributable, in the row's partition or (an older
 *  build's split) another partition holding the same id or the only copy. Folder, ambiguous and
 *  unattributable ids stay main's. */
export function legacyRelayAdoptionBatch(
  store: AdoptionStore,
  baseline: LegacyRelayBaseline
): (hostId: ExecutionHostId) => LegacyRelayAdoption {
  let tabHosts: Map<string, ExecutionHostId> | null = null
  const relaysAtStart = new Map<ExecutionHostId, Record<string, string> | undefined>()
  const relaysOf = (hostId: ExecutionHostId) => {
    if (!relaysAtStart.has(hostId)) {
      relaysAtStart.set(hostId, store.getWorkspaceSession(hostId).remoteSessionIdsByTabId)
    }
    return relaysAtStart.get(hostId)
  }
  return (hostId) => () => {
    const legacy = baseline.get(hostId)
    // Adopted once; the record's version keeps it from running again after a restart.
    baseline.delete(hostId)
    if (!legacy) {
      return {}
    }
    tabHosts ??= uniqueSshRepoTabHosts(store)
    const adopted: Record<string, string> = {}
    for (const [tabId, relayId] of Object.entries(legacy)) {
      const rowHost = tabHosts.get(tabId)
      if (!rowHost || !parseAppSshPtyId(relayId) || relaysOf(hostId)?.[tabId] !== relayId) {
        continue
      }
      const rowCopy = rowHost === hostId ? relayId : relaysOf(rowHost)?.[tabId]
      if (rowCopy === undefined || rowCopy === relayId) {
        adopted[tabId] = relayId
      }
    }
    return adopted
  }
}
