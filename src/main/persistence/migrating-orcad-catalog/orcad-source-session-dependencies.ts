import type { ExecutionHostId } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { SESSION_FIELDS_PRUNED_BY_OWNER_KEY } from '../../orca-profiles/profile-project-session-field-disposition'

export type OrcadMigrationSourceSessionInspection = {
  dependencyCount: number
  ptyIds: Set<string>
  tabIds: Set<string>
}

type SessionScope = {
  targetId: string
  hostId: ExecutionHostId
  ownerMatches: (ownerKey: string) => boolean
}

export function inspectOrcadMigrationSourceSessions(
  state: PersistedState,
  scope: SessionScope
): OrcadMigrationSourceSessionInspection {
  const aggregate: OrcadMigrationSourceSessionInspection = {
    dependencyCount: 0,
    ptyIds: new Set(),
    tabIds: new Set()
  }
  const partitions: [string, WorkspaceSessionState][] = [
    ['local', state.workspaceSession],
    ...Object.entries(state.workspaceSessionsByHostId ?? {}).flatMap(([hostId, session]) =>
      session ? [[hostId, session] as [string, WorkspaceSessionState]] : []
    )
  ]
  for (const [hostId, session] of partitions) {
    const inspected = inspectSession(session, scope, hostId === scope.hostId)
    aggregate.dependencyCount += inspected.dependencyCount
    inspected.ptyIds.forEach((value) => aggregate.ptyIds.add(value))
    inspected.tabIds.forEach((value) => aggregate.tabIds.add(value))
  }
  return aggregate
}

function inspectSession(
  session: WorkspaceSessionState,
  scope: SessionScope,
  sourceHostPartition: boolean
): OrcadMigrationSourceSessionInspection {
  const result: OrcadMigrationSourceSessionInspection = {
    dependencyCount: 0,
    ptyIds: new Set(),
    tabIds: new Set()
  }
  const matchesOwner = (ownerKey: string): boolean =>
    Boolean(ownerKey) && (sourceHostPartition || scope.ownerMatches(ownerKey))
  for (const [ownerKey, tabs] of Object.entries(session.tabsByWorktree)) {
    if (!matchesOwner(ownerKey)) {
      continue
    }
    result.dependencyCount += 1
    for (const tab of tabs) {
      result.tabIds.add(tab.id)
      if (tab.ptyId) {
        result.ptyIds.add(tab.ptyId)
      }
    }
  }
  const browserWorkspaceIds = new Set<string>()
  for (const [ownerKey, workspaces] of Object.entries(session.browserTabsByWorktree ?? {})) {
    if (!matchesOwner(ownerKey)) {
      continue
    }
    result.dependencyCount += 1
    workspaces.forEach((workspace) => browserWorkspaceIds.add(workspace.id))
  }
  for (const [ownerKey, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    if (!matchesOwner(ownerKey)) {
      continue
    }
    for (const tab of tabs) {
      if (tab.contentType === 'terminal') {
        result.tabIds.add(tab.entityId)
      } else if (tab.contentType === 'browser') {
        browserWorkspaceIds.add(tab.entityId)
      }
    }
  }
  result.dependencyCount += countOwnedRecordKeys(session, matchesOwner)
  result.dependencyCount += Object.keys(session.browserPagesByWorkspace ?? {}).filter(
    (workspaceId) => browserWorkspaceIds.has(workspaceId)
  ).length
  result.dependencyCount += Object.keys(session.terminalLayoutsByTabId).filter((tabId) =>
    result.tabIds.has(tabId)
  ).length
  result.dependencyCount += Object.keys(session.remoteSessionIdsByTabId ?? {}).filter((tabId) =>
    result.tabIds.has(tabId)
  ).length
  for (const paneKey of Object.keys(session.terminalPtyIncarnationsByPaneKey ?? {})) {
    if (orcadMigrationPaneBelongsToTabs(paneKey, result.tabIds)) {
      result.dependencyCount += 1
    }
  }
  for (const tombstone of Object.values(session.terminalSurfaceTombstonesByPaneKey ?? {})) {
    if (matchesOwner(tombstone.worktreeId)) {
      result.dependencyCount += 1
      result.ptyIds.add(tombstone.ptyId)
    }
  }
  for (const sleeping of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
    if (matchesOwner(sleeping.worktreeId) || sleeping.connectionId === scope.targetId) {
      result.dependencyCount += 1
    }
  }
  result.dependencyCount += (session.activeWorktreeIdsOnShutdown ?? []).filter(matchesOwner).length
  result.dependencyCount += session.activeRepoId && scope.ownerMatches(session.activeRepoId) ? 1 : 0
  result.dependencyCount += matchesOwner(session.activeWorktreeId ?? '') ? 1 : 0
  result.dependencyCount += matchesOwner(session.activeWorkspaceKey ?? '') ? 1 : 0
  result.dependencyCount += session.activeWorkspaceExecutionHostId === scope.hostId ? 1 : 0
  result.dependencyCount += (session.activeConnectionIdsAtShutdown ?? []).filter(
    (targetId) => targetId === scope.targetId
  ).length
  result.dependencyCount += session.activeTabId && result.tabIds.has(session.activeTabId) ? 1 : 0
  return result
}

function countOwnedRecordKeys(
  session: WorkspaceSessionState,
  matchesOwner: (ownerKey: string) => boolean
): number {
  let count = 0
  for (const field of SESSION_FIELDS_PRUNED_BY_OWNER_KEY) {
    const record = session[field] as Record<string, unknown> | undefined
    count += Object.keys(record ?? {}).filter(matchesOwner).length
  }
  return count
}

export function orcadMigrationPaneBelongsToTabs(
  paneKey: string,
  tabIds: ReadonlySet<string>
): boolean {
  for (const tabId of tabIds) {
    if (paneKey.startsWith(`${tabId}:`)) {
      return true
    }
  }
  return false
}
