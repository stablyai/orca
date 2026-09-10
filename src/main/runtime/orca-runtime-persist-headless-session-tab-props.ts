// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCloseHeadlessMobileTerminalTab } from './orca-runtime-close-headless-mobile-terminal-tab'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSessionTabProps
} from '../../shared/runtime-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/terminal-tab-types'
import { cloneTerminalLayoutSnapshot } from './mobile-session-layout-projection'
import { resolveHeadlessTerminalTabTitle } from './mobile-session-terminal-projection'
import { defaultAgentChatLabel } from '../../shared/agent-session-chat-label'
import { structuredAgentSessionIdFromHostTabId } from '../../shared/runtime-mobile-session-tab-contracts'

export class OrcaRuntimeWithPersistHeadlessSessionTabProps extends OrcaRuntimeWithCloseHeadlessMobileTerminalTab {
  protected persistHeadlessSessionTabProps(
    worktreeId: string,
    tabId: string,
    props: RuntimeSessionTabProps
  ): void {
    const structuredSessionId = structuredAgentSessionIdFromHostTabId(tabId)
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const tabs = session.tabsByWorktree[worktreeId]
    const nextSession: WorkspaceSessionState = { ...session }
    let changed = false
    if (tabs?.some((tab) => tab.id === tabId)) {
      changed = true
      nextSession.tabsByWorktree = {
        ...session.tabsByWorktree,
        [worktreeId]: tabs.map((tab) =>
          tab.id === tabId
            ? {
                ...tab,
                ...(props.color !== undefined ? { color: props.color } : {}),
                ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {}),
                ...(props.title !== undefined ? { customTitle: props.title?.trim() || null } : {}),
                ...(props.viewMode !== undefined ? { viewMode: props.viewMode } : {})
              }
            : tab
        )
      }
    }

    // A structured chat is addressed on the wire by its host tab id; its persisted unified
    // row is keyed by the bare session id, so match both or the write lands nowhere.
    const matchesUnifiedTab = (tab: { id: string; entityId: string }): boolean =>
      tab.id === tabId ||
      tab.entityId === tabId ||
      (structuredSessionId !== null && tab.entityId === structuredSessionId)
    const unifiedTabs = session.unifiedTabs?.[worktreeId]
    if (unifiedTabs?.some(matchesUnifiedTab)) {
      changed = true
      nextSession.unifiedTabs = {
        ...session.unifiedTabs,
        [worktreeId]: unifiedTabs.map((tab) =>
          matchesUnifiedTab(tab)
            ? {
                ...tab,
                ...(props.color !== undefined ? { color: props.color } : {}),
                ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {}),
                ...(props.title !== undefined ? { customLabel: props.title?.trim() || null } : {})
              }
            : tab
        )
      }
    }

    if (!changed) {
      return
    }
    this.setWorkspaceSessionForWorktree(worktreeId, nextSession)
  }

  protected applyHeadlessSessionTabPropsToSnapshot(
    worktreeId: string,
    tabId: string,
    props: RuntimeSessionTabProps
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    let changed = false
    const tabs = snapshot.tabs.map((tab) => {
      if (this.getMobileSessionTopLevelTabId(tab) !== tabId) {
        return tab
      }
      changed = true
      const title =
        props.title === undefined
          ? undefined
          : this.resolveHeadlessSessionTabDisplayTitle(worktreeId, tab, props.title)
      return {
        ...tab,
        ...(props.color !== undefined ? { color: props.color } : {}),
        ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {}),
        ...(title !== undefined ? { title } : {}),
        // Why: clients converge on the host's name, so the raw name ships beside the
        // rendered one — an unnamed chat must not read as one named after its placeholder.
        ...(title !== undefined && tab.type === 'agent-session'
          ? { customTitle: props.title?.trim() || null }
          : {}),
        ...(props.viewMode !== undefined ? { viewMode: props.viewMode } : {})
      }
    })
    if (!changed) {
      return
    }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      tabs
    }
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }

  protected getMobileSessionTopLevelTabId(tab: RuntimeMobileSessionSnapshotTab): string {
    return tab.type === 'terminal' ? tab.parentTabId : tab.id
  }

  /** What a paired client should render after a rename: the user's name, else the name this
   *  tab kind resolves to on its own. Clearing must not publish an empty label. */
  protected resolveHeadlessSessionTabDisplayTitle(
    worktreeId: string,
    tab: RuntimeMobileSessionSnapshotTab,
    title: string | null
  ): string {
    const named = title?.trim()
    if (named) {
      return named
    }
    if (tab.type === 'agent-session') {
      return defaultAgentChatLabel(tab.agent)
    }
    if (tab.type !== 'terminal') {
      return tab.title
    }
    const persisted = this.getWorkspaceSessionForWorktree(worktreeId)?.tabsByWorktree?.[
      worktreeId
    ]?.find((candidate) => candidate.id === tab.parentTabId)
    return persisted
      ? resolveHeadlessTerminalTabTitle({ ...persisted, customTitle: null }, tab.title)
      : tab.title
  }

  // Merge the client's pane structure into the persisted tab layout. PTY
  // bindings and active leaf stay host-owned; only ratios/expand/titles change.
  // terminalLayoutsByTabId is keyed by tab id (worktree-independent).
  protected persistHeadlessTerminalPaneLayout(
    worktreeId: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      titlesByLeafId?: Record<string, string>
    }
  ): TerminalLayoutSnapshot | undefined {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return undefined
    }
    const existing = session.terminalLayoutsByTabId?.[args.tabId]
    if (!existing) {
      return undefined
    }
    const candidate = {
      ...session,
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        [args.tabId]: {
          ...cloneTerminalLayoutSnapshot(existing),
          root: args.root ?? existing.root,
          expandedLeafId: args.expandedLeafId,
          ...(args.titlesByLeafId ? { titlesByLeafId: args.titlesByLeafId } : {})
        }
      }
    }
    this.setWorkspaceSessionForWorktree(worktreeId, candidate)
    // Why: persistence may reject stale membership while accepting its metadata; publish only that rebased layout.
    return (
      this.getWorkspaceSessionForWorktree(worktreeId)?.terminalLayoutsByTabId[args.tabId] ??
      candidate.terminalLayoutsByTabId[args.tabId]
    )
  }

  protected applyHeadlessTerminalPaneLayoutToSnapshot(
    worktreeId: string,
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      titlesByLeafId?: Record<string, string>
    }
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    let changed = false
    const tabs = snapshot.tabs.map((tab) => {
      if (tab.type !== 'terminal' || tab.parentTabId !== args.tabId || !tab.parentLayout) {
        return tab
      }
      changed = true
      return {
        ...tab,
        parentLayout: {
          ...tab.parentLayout,
          root: args.root ?? tab.parentLayout.root,
          expandedLeafId: args.expandedLeafId,
          ...(args.titlesByLeafId ? { titlesByLeafId: args.titlesByLeafId } : {})
        }
      }
    })
    if (!changed) {
      return
    }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      tabs
    }
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
  }
}
