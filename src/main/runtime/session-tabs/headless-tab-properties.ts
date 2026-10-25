import { OrcaRuntimeWithCloseHeadlessMobileTerminalTab } from './headless-terminal-tab-close'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionSnapshotTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../shared/terminal-tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { cloneTerminalLayoutSnapshot } from '../mobile-session-layout-projection'
import { sameStringRecord, terminalLayoutNodeEqual } from '../../../shared/terminal-layout-equality'

type HeadlessPaneLayoutEdit = {
  tabId: string
  root: TerminalPaneLayoutNode | null
  expandedLeafId: string | null
  chatLeafId?: string | null
  titlesByLeafId?: Record<string, string>
}

// Why: a remounted client pane re-sends the layout it was given; an unchanged write must not
// persist or republish the workspace to every paired client.
function paneLayoutEditIsNoOp(
  layout: Pick<TerminalLayoutSnapshot, 'root' | 'expandedLeafId' | 'chatLeafId' | 'titlesByLeafId'>,
  edit: HeadlessPaneLayoutEdit
): boolean {
  return (
    terminalLayoutNodeEqual(edit.root ?? layout.root, layout.root) &&
    (layout.expandedLeafId ?? null) === edit.expandedLeafId &&
    (edit.chatLeafId === undefined || (layout.chatLeafId ?? null) === (edit.chatLeafId ?? null)) &&
    (!edit.titlesByLeafId || sameStringRecord(layout.titlesByLeafId, edit.titlesByLeafId))
  )
}

export abstract class RuntimeHeadlessTabProperties extends OrcaRuntimeWithCloseHeadlessMobileTerminalTab {
  // Why: tab color/pin are host-authoritative for remote-server tabs but had no
  // push path, so pinning or coloring a tab reverted on the next snapshot and
  // was never persisted. Persist to the workspace session + live snapshot.
  async setMobileSessionTabProps(
    worktreeSelector: string,
    args: {
      tabId: string
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
      customTitle?: string | null
    }
  ): Promise<{ updated: true }> {
    const explicitWorktreeId = this.getExplicitSessionWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorktreeSelector(worktreeSelector)).id
    // Why: a renderer-authoritative host owns + republishes tab props, so a
    // headless write would be overwritten. Persist only when headless.
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const hostTabId = snapshot
      ? (this.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
      : args.tabId
    // Why by tab: a sleeping or starting pane has no handle for terminal.rename to name (#29975).
    const customTitle =
      args.customTitle === undefined ? undefined : args.customTitle?.trim() || null
    // Switch point: a terminal tab main owns takes its props in main's layout, window or not.
    if (ORCA_LAYOUT_OWNER_IS_MAIN && (await this.setMainTabProps(worktreeId, hostTabId, args))) {
      return { updated: true }
    }
    if (this.getAvailableAuthoritativeWindow()) {
      if (args.color !== undefined || args.isPinned !== undefined || args.viewMode !== undefined) {
        throw Object.assign(
          new Error(
            'Tab color, pin, and view mode edits are unavailable while a desktop window owns the layout'
          ),
          { code: 'capability_unsupported' }
        )
      }
      if (customTitle !== undefined) {
        this.notifier?.renameTerminal(hostTabId, customTitle)
      }
      return { updated: true }
    }
    this.persistHeadlessSessionTabProps(worktreeId, hostTabId, args)
    // Why: a live pane's own title outranks the snapshot's, so name it the way terminal.rename does.
    const liveHandles =
      customTitle === undefined
        ? []
        : this.getPtyIdsForExplicitTabClose(worktreeId, hostTabId).flatMap((ptyId) => {
            const handle = this.handleByPtyId.get(ptyId)
            return handle ? [handle] : []
          })
    for (const handle of liveHandles) {
      await this.renameTerminal(handle, customTitle ?? null)
    }
    if (customTitle !== undefined && liveHandles.length === 0) {
      this.persistHeadlessTerminalTitle(worktreeId, hostTabId, customTitle)
    }
    // A live pane's rename above already set its title; only a paneless tab needs `title` here.
    this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, hostTabId, {
      ...args,
      ...(customTitle !== undefined && liveHandles.length === 0
        ? {
            customTitle,
            title: customTitle ?? this.headlessTerminalFallbackTitle(worktreeId, hostTabId)
          }
        : {})
    })
    return { updated: true }
  }

  /** What `title` reads once a manual name is cleared; readers that predate `customTitle` show it. */
  protected headlessTerminalFallbackTitle(worktreeId: string, tabId: string): string {
    const tab = this.getWorkspaceSessionForWorktree(worktreeId)?.tabsByWorktree[worktreeId]?.find(
      (candidate) => candidate.id === tabId
    )
    return (
      tab?.generatedTitle?.trim() || tab?.title?.trim() || tab?.defaultTitle?.trim() || 'Terminal'
    )
  }

  protected persistHeadlessSessionTabProps(
    worktreeId: string,
    tabId: string,
    props: { color?: string | null; isPinned?: boolean; viewMode?: 'terminal' | 'chat' }
  ): void {
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
                ...(props.viewMode !== undefined ? { viewMode: props.viewMode } : {})
              }
            : tab
        )
      }
    }

    const unifiedTabs = session.unifiedTabs?.[worktreeId]
    // A browser row is named by its page; a window keys the tab's props by the saved tab.
    const unifiedId = this.serveBrowserTabs.unifiedTabId(worktreeId, tabId)
    if (unifiedTabs?.some((tab) => tab.id === unifiedId || tab.entityId === unifiedId)) {
      changed = true
      nextSession.unifiedTabs = {
        ...session.unifiedTabs,
        [worktreeId]: unifiedTabs.map((tab) =>
          tab.id === unifiedId || tab.entityId === unifiedId
            ? {
                ...tab,
                ...(props.color !== undefined ? { color: props.color } : {}),
                ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {})
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
    props: {
      title?: string
      customTitle?: string | null
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
    }
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
      return {
        ...tab,
        ...(props.title !== undefined ? { title: props.title } : {}),
        ...(props.customTitle !== undefined && tab.type === 'terminal'
          ? { customTitle: props.customTitle }
          : {}),
        ...(props.color !== undefined ? { color: props.color } : {}),
        ...(props.isPinned !== undefined ? { isPinned: props.isPinned } : {}),
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

  // Merge the client's pane structure into the persisted tab layout. PTY
  // bindings and active leaf stay host-owned; only ratios/expand/titles change.
  // terminalLayoutsByTabId is keyed by tab id (worktree-independent).
  protected persistHeadlessTerminalPaneLayout(
    worktreeId: string,
    args: HeadlessPaneLayoutEdit
  ): TerminalLayoutSnapshot | undefined {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return undefined
    }
    const existing = session.terminalLayoutsByTabId?.[args.tabId]
    if (!existing) {
      return undefined
    }
    if (paneLayoutEditIsNoOp(existing, args)) {
      return existing
    }
    const candidate = {
      ...session,
      terminalLayoutsByTabId: {
        ...session.terminalLayoutsByTabId,
        [args.tabId]: {
          ...cloneTerminalLayoutSnapshot(existing),
          root: args.root ?? existing.root,
          expandedLeafId: args.expandedLeafId,
          ...(args.chatLeafId !== undefined ? { chatLeafId: args.chatLeafId ?? undefined } : {}),
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
    args: HeadlessPaneLayoutEdit
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    let changed = false
    const tabs = snapshot.tabs.map((tab) => {
      if (
        tab.type !== 'terminal' ||
        tab.parentTabId !== args.tabId ||
        !tab.parentLayout ||
        paneLayoutEditIsNoOp(tab.parentLayout, args)
      ) {
        return tab
      }
      changed = true
      return {
        ...tab,
        parentLayout: {
          ...tab.parentLayout,
          root: args.root ?? tab.parentLayout.root,
          expandedLeafId: args.expandedLeafId,
          ...(args.chatLeafId !== undefined ? { chatLeafId: args.chatLeafId ?? undefined } : {}),
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
