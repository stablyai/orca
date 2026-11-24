import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { PersistedUIState } from '../../../shared/orca-profiles/persisted-ui-state-types'
import type { ProjectGroup } from '../../../shared/project/groups/project-group-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { parseAppSshPtyId, toAppSshPtyId } from '../../../shared/remote-runtime/ssh/ssh-pty-id'
import { toSshExecutionHostId } from '../../../shared/execution-host/execution-host'
import { normalizeManualRepoOrder } from '../../../shared/repository/manual-repo-order'

/** Re-adoption must migrate every persisted id carrier together or reconnect/reattach resurrects dead target ids (STA-1468). Non-session carriers mutate in place and report changes for save scheduling. */

function rewriteSshPtyId(ptyId: string, oldTargetId: string, newTargetId: string): string | null {
  const parsed = parseAppSshPtyId(ptyId)
  if (!parsed || parsed.connectionId !== oldTargetId) {
    return null
  }
  return toAppSshPtyId(newTargetId, parsed.relayPtyId)
}

/** The window keeps a rewritten relay only if it owned the old id; ownership of other keys is unchanged. */
function migratedRelayOwnership(
  session: WorkspaceSessionState,
  rewritten: Record<string, string>
): Pick<WorkspaceSessionState, 'desktopRelayOwnerByTabId'> {
  const before = session.desktopRelayOwnerByTabId
  if (!before) {
    return {}
  }
  const owners = { ...before }
  for (const [tabId, relayId] of Object.entries(rewritten)) {
    const old = session.remoteSessionIdsByTabId?.[tabId]
    if (old === relayId) {
      continue
    }
    if (owners[tabId] === old) {
      owners[tabId] = relayId
    } else {
      delete owners[tabId]
    }
  }
  return { desktopRelayOwnerByTabId: Object.keys(owners).length > 0 ? owners : undefined }
}

function rewriteSshPtyIdRecordValues(
  record: Record<string, string> | undefined,
  oldTargetId: string,
  newTargetId: string
): Record<string, string> | null {
  let next: Record<string, string> | null = null
  for (const [key, ptyId] of Object.entries(record ?? {})) {
    const rewritten = rewriteSshPtyId(ptyId, oldTargetId, newTargetId)
    if (rewritten) {
      next ??= { ...record }
      next[key] = rewritten
    }
  }
  return next
}

/** A new session with the target id rewritten, or null when nothing references the old id. */
export function migrateWorkspaceSessionSshTargetId(
  session: WorkspaceSessionState,
  oldTargetId: string,
  newTargetId: string
): WorkspaceSessionState | null {
  let next: WorkspaceSessionState | null = null
  let rows: WorkspaceSessionState['tabsByWorktree'] | null = null
  for (const [worktreeId, tabs] of Object.entries(session.tabsByWorktree ?? {})) {
    let nextTabs: typeof tabs | null = null
    for (const [index, tab] of tabs.entries()) {
      const rewritten = tab.ptyId ? rewriteSshPtyId(tab.ptyId, oldTargetId, newTargetId) : null
      if (rewritten) {
        nextTabs ??= [...tabs]
        nextTabs[index] = { ...tab, ptyId: rewritten }
      }
    }
    if (nextTabs) {
      rows ??= { ...session.tabsByWorktree }
      rows[worktreeId] = nextTabs
    }
  }
  if (rows) {
    next = { ...(next ?? session), tabsByWorktree: rows }
  }
  let layouts: WorkspaceSessionState['terminalLayoutsByTabId'] | null = null
  for (const [tabId, layout] of Object.entries(session.terminalLayoutsByTabId ?? {})) {
    const ptyIdsByLeafId = rewriteSshPtyIdRecordValues(
      layout.ptyIdsByLeafId,
      oldTargetId,
      newTargetId
    )
    if (ptyIdsByLeafId) {
      layouts ??= { ...session.terminalLayoutsByTabId }
      layouts[tabId] = { ...layout, ptyIdsByLeafId }
    }
  }
  if (layouts) {
    next = { ...(next ?? session), terminalLayoutsByTabId: layouts }
  }
  const remoteSessionIdsByTabId = rewriteSshPtyIdRecordValues(
    session.remoteSessionIdsByTabId,
    oldTargetId,
    newTargetId
  )
  if (remoteSessionIdsByTabId) {
    next = {
      ...(next ?? session),
      remoteSessionIdsByTabId,
      ...migratedRelayOwnership(session, remoteSessionIdsByTabId)
    }
  }
  if (session.activeConnectionIdsAtShutdown?.includes(oldTargetId)) {
    next = {
      ...(next ?? session),
      activeConnectionIdsAtShutdown: [
        ...new Set(
          session.activeConnectionIdsAtShutdown.map((id) => (id === oldTargetId ? newTargetId : id))
        )
      ]
    }
  }
  let sleeping: WorkspaceSessionState['sleepingAgentSessionsByPaneKey'] | null = null
  for (const [paneKey, record] of Object.entries(session.sleepingAgentSessionsByPaneKey ?? {})) {
    if (record.connectionId === oldTargetId) {
      sleeping ??= { ...session.sleepingAgentSessionsByPaneKey }
      sleeping[paneKey] = { ...record, connectionId: newTargetId }
    }
  }
  if (sleeping) {
    next = { ...(next ?? session), sleepingAgentSessionsByPaneKey: sleeping }
  }
  return next
}

/** Folder workspace and group host stamps are outside the repo sweep; leaving either stale strands workspaces and pinned automations. */
export function migrateFolderWorkspaceHostSshTargetId(
  scope: { folderWorkspaces?: FolderWorkspace[]; projectGroups?: ProjectGroup[] },
  oldTargetId: string,
  newTargetId: string
): boolean {
  const oldHostId = toSshExecutionHostId(oldTargetId)
  const newHostId = toSshExecutionHostId(newTargetId)
  let changed = false
  for (const entry of [...(scope.folderWorkspaces ?? []), ...(scope.projectGroups ?? [])]) {
    if (entry.connectionId === oldTargetId) {
      entry.connectionId = newTargetId
      changed = true
    }
    if (entry.executionHostId === oldHostId) {
      entry.executionHostId = newHostId
      changed = true
    }
  }
  return changed
}

export function migrateUiHostScopeSshTargetId(
  ui: PersistedUIState,
  oldTargetId: string,
  newTargetId: string
): boolean {
  const oldHostId = toSshExecutionHostId(oldTargetId)
  const newHostId = toSshExecutionHostId(newTargetId)
  let changed = false
  if (ui.workspaceHostScope === oldHostId) {
    ui.workspaceHostScope = newHostId
    changed = true
  }
  if (ui.visibleWorkspaceHostIds?.includes(oldHostId)) {
    ui.visibleWorkspaceHostIds = [
      ...new Set(ui.visibleWorkspaceHostIds.map((id) => (id === oldHostId ? newHostId : id)))
    ]
    changed = true
  }
  if (ui.workspaceHostOrder?.includes(oldHostId)) {
    ui.workspaceHostOrder = [
      ...new Set(ui.workspaceHostOrder.map((id) => (id === oldHostId ? newHostId : id)))
    ]
    changed = true
  }
  if (ui.manualRepoOrder?.some((entry) => entry.hostId === oldHostId)) {
    ui.manualRepoOrder = normalizeManualRepoOrder(
      ui.manualRepoOrder.map((entry) =>
        entry.hostId === oldHostId ? { ...entry, hostId: newHostId } : entry
      )
    )
    changed = true
  }
  return changed
}
