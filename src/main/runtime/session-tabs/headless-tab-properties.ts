import { renameStructuredSessionTab, type SessionTabProps } from './structured-session-tab-rename'
import { OrcaRuntimeWithHeadlessPaneMoveToNewTab } from './headless-pane-move-to-new-tab'
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

// Remounts resend unchanged layouts; avoid persisting and broadcasting them to every client.
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

export abstract class RuntimeHeadlessTabProperties extends OrcaRuntimeWithHeadlessPaneMoveToNewTab {
  // Remote tab color/pin need persistence and live publication or the next snapshot reverts them.
  async setMobileSessionTabProps(
    worktreeSelector: string,
    args: SessionTabProps
  ): Promise<{ updated: true }> {
    const explicitWorktreeId = this.getExplicitSessionWorktreeIdSelector(worktreeSelector)
    const worktreeId =
      explicitWorktreeId ?? (await this.resolveWorkspaceSelector(worktreeSelector)).id
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    // Attached renderers own and republish props; headless writes would be overwritten.
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const hostTabId = snapshot
      ? (this.resolveMobileSessionHostTabId(snapshot, args.tabId) ?? args.tabId)
      : args.tabId
    if (ORCA_LAYOUT_OWNER_IS_MAIN && (await this.setMainTabProps(worktreeId, hostTabId, args))) {
      return { updated: true }
    }
    const authoritativeWindow = this.getAvailableAuthoritativeWindow()
    if (
      authoritativeWindow &&
      (args.color !== undefined || args.isPinned !== undefined || args.viewMode !== undefined)
    ) {
      throw Object.assign(
        new Error(
          'Tab color, pin, and view mode edits are unavailable while a desktop window owns the layout'
        ),
        { code: 'capability_unsupported' }
      )
    }
    args = await renameStructuredSessionTab(snapshot, hostTabId, args, () =>
      this.ensureStructuredAgentSessionHost()
    )
    // Sleeping/starting panes lack handles, so title edits must address the tab (#29975).
    const customTitle =
      args.customTitle === undefined ? undefined : args.customTitle?.trim() || null
    if (authoritativeWindow) {
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

  // Merge only client geometry/titles; PTY bindings and active leaf remain host-owned. Layouts are keyed by tab, independent of worktree.
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
    // Publish the persisted rebase: stale membership may be rejected while metadata is accepted.
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
