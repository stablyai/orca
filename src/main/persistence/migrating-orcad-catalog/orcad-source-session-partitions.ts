import { hasClosedTerminalTabRecord } from '../../../shared/closed-terminal-tab-tombstones'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../shared/workspace-scope'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { keepUnsavedDrafts } from '../../../shared/workspace-session-draft-retention'
import {
  withoutWorkspaces,
  workspaceIdsNamedByPartition,
  workspacesTheHostSupersedes
} from '../../../shared/workspace-session-stranded-partition-adoption'
import { sessionPartitions } from './orcad-source-workspace-session-fragments'
import {
  orcadMigrationOwnerMatchesScope,
  orcadMigrationPartitionScope,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

/**
 * The partitions as the app itself reads them: the shared adoption rule decides where the host's
 * copy supersedes an older local one (#12723). Everywhere else both copies export and must agree.
 */
export function orcadMigrationSessionPartitions(
  state: PersistedState,
  scope: OrcadMigrationSourceScope
): [string, WorkspaceSessionState][] {
  const partitions = sessionPartitions(state, LOCAL_EXECUTION_HOST_ID)
  const host = partitions.find(([hostId]) => hostId === scope.hostId)?.[1]
  if (!host) {
    return partitions
  }
  const localScope = orcadMigrationPartitionScope(scope, LOCAL_EXECUTION_HOST_ID)
  const contested = new Set(
    partitions
      .filter(([hostId]) => hostId !== LOCAL_EXECUTION_HOST_ID && hostId !== scope.hostId)
      .flatMap(([, session]) => [...workspaceIdsNamedByPartition(session)])
  )
  const owned = new Set(
    Object.keys(host.tabsByWorktree ?? {})
      .filter((key) => orcadMigrationOwnerMatchesScope(key, localScope))
      .map(normalizeWorkspaceSessionKeyToWorkspaceId)
  )
  return partitions.map(([hostId, session]) => {
    if (hostId !== LOCAL_EXECUTION_HOST_ID) {
      return [hostId, session]
    }
    const superseded = workspacesTheHostSupersedes(host, owned, contested)
    for (const id of copiesThatStillDisagree(session, host)) {
      superseded.delete(id)
    }
    if (superseded.size === 0) {
      return [hostId, session]
    }
    const next = withoutWorkspaces(session, superseded)
    keepUnsavedDrafts(next, session)
    return [hostId, next]
  })
}

/** Workspaces the local copy must keep: a worker fence, or a close record for a tab the host lists. */
function copiesThatStillDisagree(
  local: WorkspaceSessionState,
  host: WorkspaceSessionState
): Set<string> {
  const kept = new Set<string>()
  for (const record of Object.values(local.sleepingAgentSessionsByPaneKey ?? {})) {
    if ('automaticResumeBlockedBy' in record && record.automaticResumeBlockedBy !== undefined) {
      kept.add(normalizeWorkspaceSessionKeyToWorkspaceId(record.worktreeId))
    }
  }
  for (const [key, tabs] of Object.entries(host.tabsByWorktree ?? {})) {
    const closed = tabs.some((tab) =>
      [local, host].some((copy) =>
        hasClosedTerminalTabRecord(copy.closedTerminalTabTombstonesByTabId, tab.id)
      )
    )
    if (closed) {
      kept.add(normalizeWorkspaceSessionKeyToWorkspaceId(key))
    }
  }
  return kept
}
