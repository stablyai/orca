import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'

/** Remote session IDs live outside the layout model and must follow the remaining pane after close. */
export function followRemoteSessionAfterPaneClose(
  command: LayoutCommand,
  stored: WorkspaceSessionState,
  written: WorkspaceSessionState
): WorkspaceSessionState {
  if (command.type !== 'closePane') {
    return written
  }
  const closedPtyId = stored.terminalLayoutsByTabId[command.tabId]?.ptyIdsByLeafId?.[command.leafId]
  const remoteSessionIds = written.remoteSessionIdsByTabId
  if (!closedPtyId || remoteSessionIds?.[command.tabId] !== closedPtyId) {
    return written
  }
  const layout = written.terminalLayoutsByTabId[command.tabId]
  const next = { ...remoteSessionIds }
  const remaining =
    layout?.ptyIdsByLeafId?.[layout.activeLeafId ?? ''] ??
    Object.values(layout?.ptyIdsByLeafId ?? {})[0]
  if (remaining) {
    next[command.tabId] = remaining
  } else {
    delete next[command.tabId]
  }
  return { ...written, remoteSessionIdsByTabId: next }
}

/** Detached panes carry their remote session ID to the new tab. */
export function followRemoteSessionAfterPaneDetach(
  command: LayoutCommand,
  written: WorkspaceSessionState
): WorkspaceSessionState {
  const targetTabId = command.type === 'movePaneToNewTab' && command.windowDetach?.tabId
  const remoteSessionIds = written.remoteSessionIdsByTabId
  if (!targetTabId || !remoteSessionIds) {
    return written
  }
  const sourceTabId =
    written.unifiedTabs?.[command.workspace]?.find((entry) => entry.id === command.tabId)
      ?.entityId ?? command.tabId
  const ptyId = written.terminalLayoutsByTabId[targetTabId]?.ptyIdsByLeafId?.[command.leafId]
  if (!ptyId || remoteSessionIds[sourceTabId] !== ptyId) {
    return written
  }
  const remaining = Object.values(
    written.terminalLayoutsByTabId[sourceTabId]?.ptyIdsByLeafId ?? {}
  )[0]
  const next = { ...remoteSessionIds, [targetTabId]: ptyId }
  if (remaining) {
    next[sourceTabId] = remaining
  } else {
    delete next[sourceTabId]
  }
  return { ...written, remoteSessionIdsByTabId: next }
}
