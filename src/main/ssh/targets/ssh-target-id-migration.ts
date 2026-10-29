import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { PersistedUIState } from '../../../shared/persisted-ui-state-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parseAppSshPtyId, toAppSshPtyId } from '../../../shared/ssh-pty-id'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { normalizeManualRepoOrder } from '../../../shared/manual-repo-order'

/** Re-adoption must migrate every persisted id carrier together or reconnect/reattach resurrects dead target ids (STA-1468). Mutate in place and report changes for save scheduling. */

function rewriteSshPtyId(ptyId: string, oldTargetId: string, newTargetId: string): string | null {
  const parsed = parseAppSshPtyId(ptyId)
  if (!parsed || parsed.connectionId !== oldTargetId) {
    return null
  }
  return toAppSshPtyId(newTargetId, parsed.relayPtyId)
}

function rewriteSshPtyIdRecordValues(
  record: Record<string, string> | undefined,
  oldTargetId: string,
  newTargetId: string
): boolean {
  if (!record) {
    return false
  }
  let changed = false
  for (const [key, ptyId] of Object.entries(record)) {
    const next = rewriteSshPtyId(ptyId, oldTargetId, newTargetId)
    if (next) {
      record[key] = next
      changed = true
    }
  }
  return changed
}

export function migrateWorkspaceSessionSshTargetId(
  session: WorkspaceSessionState,
  oldTargetId: string,
  newTargetId: string
): boolean {
  let changed = false
  for (const tabs of Object.values(session.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (!tab.ptyId) {
        continue
      }
      const next = rewriteSshPtyId(tab.ptyId, oldTargetId, newTargetId)
      if (next) {
        tab.ptyId = next
        changed = true
      }
    }
  }
  for (const layout of Object.values(session.terminalLayoutsByTabId ?? {})) {
    if (rewriteSshPtyIdRecordValues(layout.ptyIdsByLeafId, oldTargetId, newTargetId)) {
      changed = true
    }
  }
  if (rewriteSshPtyIdRecordValues(session.remoteSessionIdsByTabId, oldTargetId, newTargetId)) {
    changed = true
  }
  if (session.activeConnectionIdsAtShutdown?.includes(oldTargetId)) {
    session.activeConnectionIdsAtShutdown = [
      ...new Set(
        session.activeConnectionIdsAtShutdown.map((id) => (id === oldTargetId ? newTargetId : id))
      )
    ]
    changed = true
  }
  for (const record of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
    if (record.connectionId === oldTargetId) {
      record.connectionId = newTargetId
      changed = true
    }
  }
  return changed
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
