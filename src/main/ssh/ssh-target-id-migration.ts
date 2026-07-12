import type { PersistedUIState, WorkspaceSessionState } from '../../shared/types'
import { parseAppSshPtyId, toAppSshPtyId } from '../../shared/ssh-pty-id'
import { toSshExecutionHostId } from '../../shared/execution-host'

/**
 * Carrier sweep for SSH target re-adoption (see ssh-target-readoption.ts).
 *
 * reassignSshTargetId re-points repos/worktree metas, but the removed target's
 * id is also embedded in other persisted state: app-scoped SSH pty ids
 * ("ssh:<targetId>@@pty-N") inside the workspace session, the startup
 * reconnect list, sleeping-agent resume records, and the sidebar host-scope
 * arrays. Any survivor resurfaces later as `SSH target "<old>" not found` at
 * connect/reattach time (STA-1468), so every carrier must migrate together.
 *
 * All helpers mutate in place (matching how the Store edits this.state) and
 * return whether anything changed so callers can gate scheduleSave.
 */

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

/** Re-point every old-target-id carrier inside one workspace session partition. */
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

/** Re-point the sidebar host-scope arrays pinned to the old SSH host id. */
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
  return changed
}
