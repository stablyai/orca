import { isWorkspaceKey } from '../../../shared/workspace-scope'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { buildMarkdownFrontmatterIdMap } from '../../orca-profiles/profile-session-owner-transfer'
import {
  orcadMigrationOwnerMatchesScope,
  orcadMigrationOwnsRepoId,
  unqualifyOrcadMigrationOwnerKey,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'
import { paneBelongsToTerminalLayout } from '../../../shared/workspace-session-pane-ownership'
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
  // PTY bindings, remote session ids and shutdown markers are not counted: whether their terminals
  // still run is the terminal gate's verdict, taken before every move; the move drops them.
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
  count +=
    sourceHostPartition &&
    session.activeRepoId &&
    owns(session.activeRepoId) &&
    !scope.repoIds.has(session.activeRepoId)
      ? 1
      : 0
  // Focus outside the source partition is client focus, not host state, so it never moves.
  // activeConnectionIdsAtShutdown is not counted: it is the renderer's live "connected now" hint, and
  // the remote work it can stand for (tab PTYs, remote session ids, leases) is the terminal gate's.
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
        (tab) =>
          tab.executionHostId !== undefined && !isOrcadSourceTabHost(tab.executionHostId, scope)
      ).length
    }
  }
  return count
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
  if (orcadMigrationOwnsRepoId(scope, source.activeRepoId)) {
    transferred.activeRepoId = source.activeRepoId
  }
  if (source.activeWorktreeId && orcadMigrationOwnerMatchesScope(source.activeWorktreeId, scope)) {
    transferred.activeWorktreeId = unqualifyOrcadMigrationOwnerKey(source.activeWorktreeId)
  }
  const activeWorkspaceKey =
    source.activeWorkspaceKey && orcadMigrationOwnerMatchesScope(source.activeWorkspaceKey, scope)
      ? unqualifyOrcadMigrationOwnerKey(source.activeWorkspaceKey)
      : null
  if (activeWorkspaceKey && isWorkspaceKey(activeWorkspaceKey)) {
    transferred.activeWorkspaceKey = activeWorkspaceKey
  }
  if (source.activeWorkspaceExecutionHostId === scope.hostId) {
    transferred.activeWorkspaceExecutionHostId = LOCAL_EXECUTION_HOST_ID
  }
  if (source.activeTabId && terminalTabIds.has(source.activeTabId)) {
    transferred.activeTabId = source.activeTabId
  }
}

/** Older builds stamped 'local' on tabs created in an SSH worktree; its owner key proves the host. */
function isOrcadSourceTabHost(executionHostId: string, scope: OrcadMigrationSourceScope): boolean {
  return executionHostId === scope.hostId || executionHostId === LOCAL_EXECUTION_HOST_ID
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
