import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { decodeSavedLocalPtyId } from '../../../../shared/terminal/pty/lifecycle/pty-session-id-format'

export function decodeSavedLocalPtyReference<T extends { ptyId: string | null }>(row: T): T {
  if (row.ptyId === null) {
    return row
  }
  const ptyId = decodeSavedLocalPtyId(row.ptyId)
  return ptyId === row.ptyId ? row : { ...row, ptyId }
}

function mapChangedRecord<T>(
  source: Record<string, T> | undefined,
  decode: (value: T) => T
): Record<string, T> | undefined {
  if (!source) {
    return source
  }
  let changed = false
  const next = Object.fromEntries(
    Object.entries(source).map(([key, value]) => {
      const decoded = decode(value)
      changed ||= decoded !== value
      return [key, decoded]
    })
  )
  return changed ? next : source
}

/** Run only for the loaded local partition; remote handles and their host remain opaque. */
export function decodeLoadedLocalTerminalIds(
  session: WorkspaceSessionState
): WorkspaceSessionState {
  const tabsByWorktree = mapChangedRecord(session.tabsByWorktree, (tabs) => {
    const next = tabs.map(decodeSavedLocalPtyReference)
    return next.some((tab, index) => tab !== tabs[index]) ? next : tabs
  })
  const terminalLayoutsByTabId = mapChangedRecord(session.terminalLayoutsByTabId, (layout) => {
    const ptyIdsByLeafId = mapChangedRecord(layout.ptyIdsByLeafId, decodeSavedLocalPtyId)
    return ptyIdsByLeafId === layout.ptyIdsByLeafId ? layout : { ...layout, ptyIdsByLeafId }
  })
  const closedTerminalPanesByPaneKey = mapChangedRecord(
    session.closedTerminalPanesByPaneKey,
    decodeSavedLocalPtyReference
  )
  const terminalSurfaceTombstonesByPaneKey = mapChangedRecord(
    session.terminalSurfaceTombstonesByPaneKey,
    decodeSavedLocalPtyReference
  )
  if (
    tabsByWorktree === session.tabsByWorktree &&
    terminalLayoutsByTabId === session.terminalLayoutsByTabId &&
    closedTerminalPanesByPaneKey === session.closedTerminalPanesByPaneKey &&
    terminalSurfaceTombstonesByPaneKey === session.terminalSurfaceTombstonesByPaneKey
  ) {
    return session
  }
  return {
    ...session,
    tabsByWorktree: tabsByWorktree ?? session.tabsByWorktree,
    terminalLayoutsByTabId: terminalLayoutsByTabId ?? session.terminalLayoutsByTabId,
    closedTerminalPanesByPaneKey,
    terminalSurfaceTombstonesByPaneKey
  }
}
