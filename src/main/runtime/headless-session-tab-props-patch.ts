import type { RuntimeMobileSessionSnapshotTab } from '../../shared/runtime-types'
import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/** Host-tracked tab props; `chatLeafId` null clears the owner, undefined leaves it. */
export type HeadlessSessionTabProps = {
  color?: string | null
  isPinned?: boolean
  viewMode?: 'terminal' | 'chat'
  chatLeafId?: string | null
  /** Null retires the tab's launch hint (its agent was proven to have exited). */
  launchAgent?: null
}

function withTabProps<
  T extends { color?: string | null; isPinned?: boolean; viewMode?: string; launchAgent?: unknown }
>(tab: T, props: HeadlessSessionTabProps): T {
  const next = {
    ...tab,
    ...(props.color !== undefined ? { color: props.color } : {}),
    ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {}),
    ...(props.viewMode !== undefined ? { viewMode: props.viewMode } : {})
  }
  if (props.launchAgent === null) {
    delete next.launchAgent
  }
  return next
}

function withChatOwner(
  layout: TerminalLayoutSnapshot,
  chatLeafId: string | null
): TerminalLayoutSnapshot {
  const { chatLeafId: _previousOwner, ...ownerless } = layout
  return chatLeafId ? { ...ownerless, chatLeafId } : ownerless
}

/** One session write for every index a tab prop lives in: row, unified tab and layout owner. */
export function buildHeadlessSessionTabPropsPatch(
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string,
  props: HeadlessSessionTabProps
): WorkspaceSessionState | null {
  const nextSession: WorkspaceSessionState = { ...session }
  let changed = false
  const tabs = session.tabsByWorktree[worktreeId]
  if (tabs?.some((tab) => tab.id === tabId)) {
    changed = true
    nextSession.tabsByWorktree = {
      ...session.tabsByWorktree,
      [worktreeId]: tabs.map((tab) => (tab.id === tabId ? withTabProps(tab, props) : tab))
    }
  }

  const unifiedTabs = session.unifiedTabs?.[worktreeId]
  if (unifiedTabs?.some((tab) => tab.id === tabId || tab.entityId === tabId)) {
    changed = true
    nextSession.unifiedTabs = {
      ...session.unifiedTabs,
      [worktreeId]: unifiedTabs.map((tab) =>
        tab.id === tabId || tab.entityId === tabId ? withTabProps(tab, props) : tab
      )
    }
  }

  const layout = session.terminalLayoutsByTabId?.[tabId]
  if (props.chatLeafId !== undefined && layout) {
    changed = true
    nextSession.terminalLayoutsByTabId = {
      ...session.terminalLayoutsByTabId,
      [tabId]: withChatOwner(layout, props.chatLeafId)
    }
  }
  return changed ? nextSession : null
}

export function applySessionTabPropsToSnapshotTab(
  tab: RuntimeMobileSessionSnapshotTab,
  props: HeadlessSessionTabProps
): RuntimeMobileSessionSnapshotTab {
  const next = withTabProps(tab, props)
  if (props.chatLeafId === undefined || next.type !== 'terminal' || !next.parentLayout) {
    return next
  }
  return { ...next, parentLayout: withChatOwner(next.parentLayout, props.chatLeafId) }
}
