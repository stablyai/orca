import type { Store } from './loading-store/store'
import {
  getRepoExecutionHostId,
  getRepoSshConnectionId,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import { parseAppSshPtyId } from '../../shared/remote-runtime/ssh/ssh-pty-id'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../shared/workspace/identity/workspace-scope'
import { workspaceSessionPartitionHostId } from '../../shared/workspace-session/workspace-session-partition-owner'
import {
  DESKTOP_RELAY_LEGACY_ADOPTION_VERSION,
  type LegacyRelayAdoption
} from '../../shared/workspace-session/desktop-relay-ownership'

type AdoptionStore = Pick<Store, 'getRepos' | 'getWorkspaceSession' | 'getWorkspaceSessionHostIds'>

/** Per partition still awaiting adoption: the relay ids saved before ownership was recorded that the
 *  window may take as its own. Worked out once before any window or main writer runs, so an id main
 *  writes later is never mistaken for one an older build's window wrote, and a first save moving rows
 *  between partitions can't hide them. A partition leaves once its adoption is stored. */
export type LegacyRelayBaseline = Map<ExecutionHostId, Record<string, string>>

/** An id is adoptable when it belongs to an SSH repo tab whose row is uniquely attributable, in the
 *  row's partition or (an older build's split) another partition holding the same id or the only copy.
 *  Folder, ambiguous and unattributable ids stay main's. */
export function captureLegacyRelayBaseline(store: AdoptionStore): LegacyRelayBaseline {
  const pending = new Map<ExecutionHostId, Record<string, string>>()
  const relaysAtStart = new Map<ExecutionHostId, Record<string, string> | undefined>()
  for (const hostId of store.getWorkspaceSessionHostIds()) {
    const session = store.getWorkspaceSession(hostId)
    relaysAtStart.set(hostId, session.remoteSessionIdsByTabId)
    const adopted =
      (session.desktopRelayAdoptionVersion ?? 0) >= DESKTOP_RELAY_LEGACY_ADOPTION_VERSION
    const saved = session.remoteSessionIdsByTabId
    if (!adopted && saved && Object.keys(saved).length > 0) {
      pending.set(hostId, saved)
    }
  }
  const baseline: LegacyRelayBaseline = new Map()
  // Nothing to adopt (every launch after the first upgrade): read no rows.
  if (pending.size === 0) {
    return baseline
  }
  const tabHosts = uniqueSshRepoTabHosts(store)
  for (const [hostId, legacy] of pending) {
    const adoptable: Record<string, string> = {}
    for (const [tabId, relayId] of Object.entries(legacy)) {
      const rowHost = tabHosts.get(tabId)
      if (!rowHost || !parseAppSshPtyId(relayId)) {
        continue
      }
      const rowCopy = rowHost === hostId ? relayId : relaysAtStart.get(rowHost)?.[tabId]
      if (rowCopy === undefined || rowCopy === relayId) {
        adoptable[tabId] = relayId
      }
    }
    if (Object.keys(adoptable).length > 0) {
      baseline.set(hostId, adoptable)
    }
  }
  return baseline
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
      const repo = repoById.get(
        getRepoIdFromWorktreeId(normalizeWorkspaceSessionKeyToWorkspaceId(worktreeId))
      )
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

/** One apply batch's adoption. A partition whose stored version shows it already adopted (a write
 *  stored by an earlier batch) leaves the baseline first. */
export function legacyRelayAdoptionBatch(
  store: AdoptionStore,
  baseline: LegacyRelayBaseline,
  // The partitions this batch writes.
  hostIds: readonly ExecutionHostId[]
): (hostId: ExecutionHostId) => LegacyRelayAdoption {
  for (const hostId of hostIds) {
    if (
      baseline.has(hostId) &&
      (store.getWorkspaceSession(hostId).desktopRelayAdoptionVersion ?? 0) >=
        DESKTOP_RELAY_LEGACY_ADOPTION_VERSION
    ) {
      baseline.delete(hostId)
    }
  }
  return (hostId) => () => baseline.get(hostId) ?? {}
}
