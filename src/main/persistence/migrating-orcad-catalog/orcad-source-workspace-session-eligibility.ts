import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { buildMarkdownFrontmatterIdMap } from '../../orca-profiles/profile-session-owner-transfer'
import {
  orcadMigrationOwnerMatchesScope,
  unqualifyOrcadMigrationOwnerKey,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'
import {
  paneBelongsToTabs,
  paneBelongsToTerminalLayout
} from './orcad-source-workspace-session-layout'
import { collectSessionOwnerKeys } from './orcad-source-workspace-session-fragments'

export function countUnrepresentableMarkdownState(
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope,
  sourceHostPartition: boolean
): number {
  const projection = {
    mapOwnerKey: (ownerKey: string) =>
      sourceHostPartition || orcadMigrationOwnerMatchesScope(ownerKey, scope)
        ? unqualifyOrcadMigrationOwnerKey(ownerKey)
        : null,
    mapWorktreeId: unqualifyOrcadMigrationOwnerKey
  }
  const mappings = buildMarkdownFrontmatterIdMap(session.openFilesByWorktree, projection)
  return Object.keys(session.markdownFrontmatterVisible ?? {}).filter(
    (fileId) => mappings.get(fileId) === null
  ).length
}

export function countUnsupportedSessionState(
  state: PersistedState,
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope,
  sourceHostPartition: boolean,
  terminalTabIds: ReadonlySet<string>
): number {
  const owns = (ownerKey: string): boolean => orcadMigrationOwnerMatchesScope(ownerKey, scope)
  const matches = (ownerKey: string): boolean =>
    Boolean(ownerKey) && (sourceHostPartition || owns(ownerKey))
  let count = sourceHostPartition
    ? [...collectSessionOwnerKeys(session)].filter((ownerKey) => !owns(ownerKey)).length
    : 0
  for (const [ownerKey, tabs] of Object.entries(session.tabsByWorktree)) {
    if (!owns(ownerKey)) {
      continue
    }
    tabs.forEach((tab) => {
      count += tab.ptyId ? 1 : 0
    })
  }
  for (const tabId of terminalTabIds) {
    const layout = session.terminalLayoutsByTabId[tabId]
    count += Object.keys(layout?.ptyIdsByLeafId ?? {}).length
    count += session.remoteSessionIdsByTabId?.[tabId] ? 1 : 0
  }
  count += Object.keys(session.terminalPtyIncarnationsByPaneKey ?? {}).filter((paneKey) =>
    paneBelongsToTabs(paneKey, terminalTabIds)
  ).length
  count += Object.values(session.sleepingAgentSessionsByPaneKey ?? {}).filter((record) => {
    const touchesSource = matches(record.worktreeId) || record.connectionId === scope.targetId
    return (
      touchesSource && !transferableSleepingAgentSession(record, session, scope, terminalTabIds)
    )
  }).length
  count += Object.entries(session.clientHostedBrowserPagesByWorktree ?? {})
    .filter(([ownerKey]) => matches(ownerKey))
    .filter(
      ([ownerKey, pages]) => !clientHostedPagesAreTransferable(session, ownerKey, pages)
    ).length
  count += (session.activeWorktreeIdsOnShutdown ?? []).filter(
    (worktreeId) =>
      matches(worktreeId) &&
      shutdownMarkerHasTerminalAuthority(state, session, scope, sourceHostPartition, worktreeId)
  ).length
  count +=
    session.activeRepoId &&
    owns(session.activeRepoId) &&
    !(sourceHostPartition && scope.repoIds.has(session.activeRepoId))
      ? 1
      : 0
  count +=
    session.activeWorktreeId &&
    matches(session.activeWorktreeId) &&
    !(sourceHostPartition && orcadMigrationOwnerMatchesScope(session.activeWorktreeId, scope))
      ? 1
      : 0
  count +=
    session.activeWorkspaceKey &&
    matches(session.activeWorkspaceKey) &&
    !(sourceHostPartition && orcadMigrationOwnerMatchesScope(session.activeWorkspaceKey, scope))
      ? 1
      : 0
  count += session.activeWorkspaceExecutionHostId === scope.hostId && !sourceHostPartition ? 1 : 0
  count += (session.activeConnectionIdsAtShutdown ?? []).filter(
    (targetId) => targetId === scope.targetId
  ).length
  count +=
    session.activeTabId && terminalTabIds.has(session.activeTabId) && !sourceHostPartition ? 1 : 0
  for (const [ownerKey, files] of Object.entries(session.openFilesByWorktree ?? {})) {
    if (owns(ownerKey)) {
      count += files.filter(
        (file) => file.externalSshTargetId !== undefined || Boolean(file.runtimeEnvironmentId)
      ).length
    }
  }
  for (const [ownerKey, workspaces] of Object.entries(session.browserTabsByWorktree ?? {})) {
    if (owns(ownerKey)) {
      count += workspaces.filter((workspace) =>
        Boolean(workspace.sessionProfileId || workspace.sessionPartition)
      ).length
    }
  }
  for (const [ownerKey, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    if (owns(ownerKey)) {
      count += tabs.filter(
        (tab) => tab.executionHostId !== undefined && tab.executionHostId !== scope.hostId
      ).length
    }
  }
  return count
}

export function shutdownMarkerHasTerminalAuthority(
  state: PersistedState,
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope,
  sourceHostPartition: boolean,
  worktreeId: string
): boolean {
  const marker = unqualifyOrcadMigrationOwnerKey(worktreeId)
  const ownerMatchesMarker = (ownerKey: string): boolean =>
    (sourceHostPartition || orcadMigrationOwnerMatchesScope(ownerKey, scope)) &&
    unqualifyOrcadMigrationOwnerKey(ownerKey) === marker
  const tabIds = new Set<string>()
  for (const [ownerKey, tabs] of Object.entries(session.tabsByWorktree)) {
    if (!ownerMatchesMarker(ownerKey)) {
      continue
    }
    for (const tab of tabs) {
      tabIds.add(tab.id)
      if (tab.ptyId) {
        return true
      }
      const layout = session.terminalLayoutsByTabId[tab.id]
      if (Object.keys(layout?.ptyIdsByLeafId ?? {}).length > 0) {
        return true
      }
      if (session.remoteSessionIdsByTabId?.[tab.id]) {
        return true
      }
    }
  }
  if (
    Object.keys(session.terminalPtyIncarnationsByPaneKey ?? {}).some((paneKey) =>
      paneBelongsToTabs(paneKey, tabIds)
    )
  ) {
    return true
  }
  return state.sshRemotePtyLeases.some(
    (lease) =>
      lease.targetId === scope.targetId &&
      lease.state !== 'terminated' &&
      (lease.worktreeId === undefined ||
        unqualifyOrcadMigrationOwnerKey(lease.worktreeId) === marker)
  )
}

function clientHostedPagesAreTransferable(
  session: WorkspaceSessionState,
  ownerKey: string,
  pages: NonNullable<WorkspaceSessionState['clientHostedBrowserPagesByWorktree']>[string]
): boolean {
  const browserWorkspaceIds = new Set(
    (session.browserTabsByWorktree?.[ownerKey] ?? []).map((workspace) => workspace.id)
  )
  return pages.every((page) => browserWorkspaceIds.has(page.workspaceId))
}

export function projectDormantSessionFocus(
  source: WorkspaceSessionState,
  transferred: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope,
  terminalTabIds: ReadonlySet<string>
): void {
  // These scalars are UI focus, not execution ownership. They are safe to carry
  // only from the source host partition and only when they point at an entity
  // already proven dormant and included in the projected session.
  if (source.activeRepoId && scope.repoIds.has(source.activeRepoId)) {
    transferred.activeRepoId = source.activeRepoId
  }
  if (source.activeWorktreeId && orcadMigrationOwnerMatchesScope(source.activeWorktreeId, scope)) {
    transferred.activeWorktreeId = unqualifyOrcadMigrationOwnerKey(source.activeWorktreeId)
  }
  if (
    source.activeWorkspaceKey &&
    orcadMigrationOwnerMatchesScope(source.activeWorkspaceKey, scope)
  ) {
    transferred.activeWorkspaceKey = unqualifyOrcadMigrationOwnerKey(
      source.activeWorkspaceKey
    ) as WorkspaceSessionState['activeWorkspaceKey']
  }
  if (source.activeWorkspaceExecutionHostId === scope.hostId) {
    transferred.activeWorkspaceExecutionHostId = LOCAL_EXECUTION_HOST_ID
  }
  if (source.activeTabId && terminalTabIds.has(source.activeTabId)) {
    transferred.activeTabId = source.activeTabId
  }
}

export function projectSessionToDestination(
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope
): WorkspaceSessionState {
  const projected = structuredClone(session)
  for (const tabs of Object.values(projected.unifiedTabs ?? {})) {
    for (const tab of tabs) {
      if (tab.executionHostId === scope.hostId) {
        tab.executionHostId = LOCAL_EXECUTION_HOST_ID
      }
    }
  }
  return projected
}

export function transferableSleepingAgentSession(
  record: SleepingAgentSessionRecord,
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope,
  terminalTabIds: ReadonlySet<string>
): boolean {
  return (
    orcadMigrationOwnerMatchesScope(record.worktreeId, scope) &&
    (record.connectionId == null || record.connectionId === scope.targetId) &&
    // Older profiles can still contain a worker-resume fence; never discard its authority.
    (!('automaticResumeBlockedBy' in record) || record.automaticResumeBlockedBy === undefined) &&
    ((record.origin ?? 'worktree-sleep') === 'worktree-sleep' ||
      paneBelongsToTerminalLayout(record, session, terminalTabIds))
  )
}
