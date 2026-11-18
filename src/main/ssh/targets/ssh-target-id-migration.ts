import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { PersistedUIState } from '../../../shared/orca-profiles/persisted-ui-state-types'
import type { ProjectGroup } from '../../../shared/project/groups/project-group-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { parseAppSshPtyId, toAppSshPtyId } from '../../../shared/remote-runtime/ssh/ssh-pty-id'
import { toSshExecutionHostId } from '../../../shared/execution-host/execution-host'
import { normalizeManualRepoOrder } from '../../../shared/repository/manual-repo-order'

/** Re-adoption must migrate every persisted id carrier together or reconnect/reattach resurrects dead target ids (STA-1468). Replace changed entries (incremental saves compare them by identity) and report changes for save scheduling. */

function rewriteSshPtyId(ptyId: string, oldTargetId: string, newTargetId: string): string | null {
  const parsed = parseAppSshPtyId(ptyId)
  if (!parsed || parsed.connectionId !== oldTargetId) {
    return null
  }
  return toAppSshPtyId(newTargetId, parsed.relayPtyId)
}

function rewrittenSshPtyIdRecord(
  record: Record<string, string> | undefined,
  oldTargetId: string,
  newTargetId: string
): Record<string, string> | undefined {
  let rewritten: Record<string, string> | undefined
  for (const [key, ptyId] of Object.entries(record ?? {})) {
    const next = rewriteSshPtyId(ptyId, oldTargetId, newTargetId)
    if (next) {
      rewritten ??= { ...record }
      rewritten[key] = next
    }
  }
  return rewritten
}

/** A copy of the record with changed entries replaced, or undefined when nothing changed. */
function withReplacedEntries<T>(
  record: Record<string, T> | undefined,
  replace: (entry: T) => T
): Record<string, T> | undefined {
  let next: Record<string, T> | undefined
  for (const [key, entry] of Object.entries(record ?? {})) {
    const replaced = replace(entry)
    if (replaced !== entry) {
      next ??= { ...record }
      next[key] = replaced
    }
  }
  return next
}

export function migrateWorkspaceSessionSshTargetId(
  session: WorkspaceSessionState,
  oldTargetId: string,
  newTargetId: string
): boolean {
  let changed = false
  const rewritten = (ptyId: string | null | undefined): string | null =>
    ptyId ? rewriteSshPtyId(ptyId, oldTargetId, newTargetId) : null
  const tabsByWorktree = withReplacedEntries(session.tabsByWorktree, (tabs) =>
    tabs.some((tab) => rewritten(tab.ptyId))
      ? tabs.map((tab) => {
          const ptyId = rewritten(tab.ptyId)
          return ptyId ? { ...tab, ptyId } : tab
        })
      : tabs
  )
  if (tabsByWorktree) {
    session.tabsByWorktree = tabsByWorktree
    changed = true
  }
  const layouts = withReplacedEntries(session.terminalLayoutsByTabId, (layout) => {
    const ptyIdsByLeafId = rewrittenSshPtyIdRecord(layout.ptyIdsByLeafId, oldTargetId, newTargetId)
    return ptyIdsByLeafId ? { ...layout, ptyIdsByLeafId } : layout
  })
  if (layouts) {
    session.terminalLayoutsByTabId = layouts
    changed = true
  }
  const remoteSessionIds = rewrittenSshPtyIdRecord(
    session.remoteSessionIdsByTabId,
    oldTargetId,
    newTargetId
  )
  if (remoteSessionIds) {
    session.remoteSessionIdsByTabId = remoteSessionIds
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
  const sleeping = withReplacedEntries(session.sleepingAgentSessionsByPaneKey, (record) =>
    record.connectionId === oldTargetId ? { ...record, connectionId: newTargetId } : record
  )
  if (sleeping) {
    session.sleepingAgentSessionsByPaneKey = sleeping
    changed = true
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
