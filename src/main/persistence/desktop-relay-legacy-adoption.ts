import type { Store } from './loading-store/store'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
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

/** Relay ids saved before ownership was recorded, with where each tab row and relay id lived, all read
 *  once before any window or main writer runs: an id main writes later is never mistaken for one an
 *  older build's window wrote, and a first save moving rows between partitions can't hide them. */
export type LegacyRelayBaseline = {
  /** Partitions still awaiting adoption, with their saved ids. */
  relaysByHost: Map<ExecutionHostId, Record<string, string>>
  tabHosts: ReadonlyMap<string, ExecutionHostId>
  relaysAtStart: ReadonlyMap<ExecutionHostId, Record<string, string> | undefined>
}

export function captureLegacyRelayBaseline(store: AdoptionStore): LegacyRelayBaseline {
  const relaysByHost = new Map<ExecutionHostId, Record<string, string>>()
  for (const hostId of store.getWorkspaceSessionHostIds()) {
    const session = store.getWorkspaceSession(hostId)
    const adopted =
      (session.desktopRelayAdoptionVersion ?? 0) >= DESKTOP_RELAY_LEGACY_ADOPTION_VERSION
    const saved = session.remoteSessionIdsByTabId
    if (!adopted && saved && Object.keys(saved).length > 0) {
      relaysByHost.set(hostId, { ...saved })
    }
  }
  // Nothing to adopt (every launch after the first upgrade): read no rows.
  if (relaysByHost.size === 0) {
    return { relaysByHost, tabHosts: new Map(), relaysAtStart: new Map() }
  }
  return {
    relaysByHost,
    tabHosts: uniqueSshRepoTabHosts(store),
    relaysAtStart: new Map(
      store
        .getWorkspaceSessionHostIds()
        .map((hostId) => [hostId, store.getWorkspaceSession(hostId).remoteSessionIdsByTabId])
    )
  }
}

/** The host each tab row's relay id belongs to, when the row is in exactly one partition under a
 *  worktree of an SSH repo the window saves: its repo's partition, which an older build may not be the
 *  one storing the row (the window's next save routes it there). */
function uniqueSshRepoTabHosts(store: AdoptionStore): Map<string, ExecutionHostId> {
  const repoById = new Map(store.getRepos().map((repo) => [repo.id, repo]))
  const hostByTab = new Map<string, ExecutionHostId | null>()
  for (const hostId of store.getWorkspaceSessionHostIds()) {
    for (const [worktreeId, tabs] of Object.entries(
      store.getWorkspaceSession(hostId).tabsByWorktree ?? {}
    )) {
      const repo = repoById.get(getRepoIdFromWorktreeId(worktreeId))
      const owner =
        repo && getRepoSshConnectionId(repo)
          ? workspaceSessionPartitionHostId(getRepoExecutionHostId(repo))
          : null
      for (const tab of tabs) {
        const seen = hostByTab.get(tab.id)
        // Copies of a row (an older build's leftovers) are ambiguous only when they name different hosts.
        hostByTab.set(tab.id, seen === undefined || seen === owner ? owner : null)
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

/** One apply batch's adoption. An id is adopted when it still equals its pre-upgrade value and belongs
 *  to an SSH repo tab whose row was uniquely attributable at startup, in the row's partition or (an
 *  older build's split) another partition holding the same id or the only copy. Folder, ambiguous and
 *  unattributable ids stay main's. */
export function legacyRelayAdoptionBatch(
  store: AdoptionStore,
  baseline: LegacyRelayBaseline,
  // The partitions this batch writes.
  hostIds: readonly ExecutionHostId[]
): (hostId: ExecutionHostId) => LegacyRelayAdoption {
  // A partition's stored version records its adoption; drop it from the baseline only then, so a
  // write that failed to store still adopts on its retry.
  for (const hostId of hostIds) {
    if (
      baseline.relaysByHost.has(hostId) &&
      (store.getWorkspaceSession(hostId).desktopRelayAdoptionVersion ?? 0) >=
        DESKTOP_RELAY_LEGACY_ADOPTION_VERSION
    ) {
      baseline.relaysByHost.delete(hostId)
    }
  }
  const { tabHosts, relaysAtStart } = baseline
  return (hostId) => () => {
    const legacy = baseline.relaysByHost.get(hostId)
    if (!legacy) {
      return {}
    }
    const adopted: Record<string, string> = {}
    for (const [tabId, relayId] of Object.entries(legacy)) {
      const rowHost = tabHosts.get(tabId)
      if (!rowHost || !parseAppSshPtyId(relayId)) {
        continue
      }
      const rowCopy = rowHost === hostId ? relayId : relaysAtStart.get(rowHost)?.[tabId]
      if (rowCopy === undefined || rowCopy === relayId) {
        adopted[tabId] = relayId
      }
    }
    return adopted
  }
}
