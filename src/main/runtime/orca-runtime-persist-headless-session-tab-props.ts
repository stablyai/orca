// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCloseHeadlessMobileTerminalTab } from './orca-runtime-close-headless-mobile-terminal-tab'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/terminal-tab-types'
import { cloneTerminalLayoutSnapshot } from './mobile-session-layout-projection'
import {
  applySessionTabPropsToSnapshotTab,
  buildHeadlessSessionTabPropsPatch,
  type HeadlessSessionTabProps
} from './headless-session-tab-props-patch'
import {
  pickSessionTabChatOwner,
  readHeadlessChatPairState,
  readPublishedChatPairState,
  toSessionTabChatView
} from './session-tab-chat-pair'
import type {
  RuntimeSessionTabChatView,
  RuntimeSessionTabChatViewWrite,
  RuntimeSessionTabPropsResult
} from '../../shared/runtime-session-contracts'
import { resolveTerminalChatPairWrite } from '../../shared/terminal-tab-view-mode'

export class OrcaRuntimeWithPersistHeadlessSessionTabProps extends OrcaRuntimeWithCloseHeadlessMobileTerminalTab {
  protected persistHeadlessSessionTabProps(
    worktreeId: string,
    tabId: string,
    props: HeadlessSessionTabProps
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const nextSession = buildHeadlessSessionTabPropsPatch(session, worktreeId, tabId, props)
    if (nextSession) {
      this.setWorkspaceSessionForWorktree(worktreeId, nextSession)
    }
  }

  protected applyHeadlessSessionTabPropsToSnapshot(
    worktreeId: string,
    tabId: string,
    props: HeadlessSessionTabProps
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
      return applySessionTabPropsToSnapshotTab(tab, props)
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

  // One session write and one snapshot bump for the whole pair: row + unified viewMode and owner.
  protected applyHeadlessChatPairWrite(
    worktreeId: string,
    parentTabId: string,
    leafId: string | null,
    viewMode: 'terminal' | 'chat',
    props: Pick<HeadlessSessionTabProps, 'color' | 'isPinned'>
  ): void {
    const state = readHeadlessChatPairState(
      this.getWorkspaceSessionForWorktree(worktreeId),
      this.mobileSessionTabsByWorktree.get(worktreeId),
      worktreeId,
      parentTabId
    )
    if (!state) {
      return
    }
    // Why: a tab with no layout has one derived pane, which owns chat without an owner id.
    const next = resolveTerminalChatPairWrite({
      current: state.pair,
      root: state.root,
      viewMode,
      leafId: state.hasLayout ? leafId : null,
      ...(state.hasLayout ? { pickOwner: () => this.pickChatOwnerLeafForLayout(state.layout) } : {})
    })
    if (!next) {
      if (props.color !== undefined || props.isPinned !== undefined) {
        this.persistHeadlessSessionTabProps(worktreeId, parentTabId, props)
        this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, parentTabId, props)
      }
      return
    }
    const pairProps: HeadlessSessionTabProps = {
      ...props,
      viewMode: next.viewMode,
      ...(state.hasLayout ? { chatLeafId: next.chatLeafId ?? null } : {})
    }
    this.persistHeadlessSessionTabProps(worktreeId, parentTabId, pairProps)
    this.applyHeadlessSessionTabPropsToSnapshot(worktreeId, parentTabId, pairProps)
  }

  /** A desktop host's fenced pair write, relayed to the renderer that owns the tab. */
  protected async relayChatPairWrite(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
    target: { parentTabId: string; leafId: string | null },
    viewMode: 'terminal' | 'chat',
    write: RuntimeSessionTabChatViewWrite
  ): Promise<RuntimeSessionTabPropsResult> {
    const notifier = this.notifier
    if (!notifier?.setTerminalChatView) {
      throw new Error('runtime_unavailable')
    }
    const refused = this.admitChatViewWrite(worktreeId, target.parentTabId, write)
    if (refused) {
      return refused
    }
    // Why always send the pick (null = no agent pane): the renderer decides once, on its own store.
    const ownerPick =
      viewMode === 'chat' && target.leafId === null
        ? [
            this.pickChatOwnerLeafForLayout(
              readPublishedChatPairState(snapshot, target.parentTabId)?.layout
            )
          ]
        : []
    // Why confirm only on success: a resend after a failed or still-pending relay must apply.
    const chatView = await notifier.setTerminalChatView(
      worktreeId,
      target.parentTabId,
      target.leafId,
      viewMode,
      ...ownerPick
    )
    this.chatViewWriteFence.confirm(worktreeId, target.parentTabId, write.writerId, write.seq)
    return { updated: true, chatView }
  }

  protected pickChatOwnerLeafForLayout(layout: TerminalLayoutSnapshot | undefined): string | null {
    return pickSessionTabChatOwner(layout, (ptyId) => this.ptysById.get(ptyId)?.launchAgent)
  }

  /** The reply for a write the fence refuses, or null when it applies. */
  protected admitChatViewWrite(
    worktreeId: string,
    parentTabId: string,
    write: RuntimeSessionTabChatViewWrite
  ): RuntimeSessionTabPropsResult | null {
    const admission = this.chatViewWriteFence.admit(
      worktreeId,
      parentTabId,
      write.writerId,
      write.seq
    )
    if (admission === 'apply') {
      return null
    }
    return {
      updated: true,
      chatView: this.readMobileSessionTabChatView(worktreeId, parentTabId),
      ...(admission === 'superseded' ? { superseded: true as const } : {})
    }
  }

  protected readMobileSessionTabChatView(
    worktreeId: string,
    parentTabId: string
  ): RuntimeSessionTabChatView {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    // Why: a renderer-owned tab's truth is the renderer's latest publication.
    return toSessionTabChatView(
      this.getAvailableAuthoritativeWindow()
        ? readPublishedChatPairState(snapshot, parentTabId)
        : readHeadlessChatPairState(
            this.getWorkspaceSessionForWorktree(worktreeId),
            snapshot,
            worktreeId,
            parentTabId
          )
    )
  }

  protected getMobileSessionTopLevelTabId(tab: RuntimeMobileSessionSnapshotTab): string {
    return tab.type === 'terminal' ? tab.parentTabId : tab.id
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
      chatLeafId?: string | null
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
    args: {
      tabId: string
      root: TerminalPaneLayoutNode | null
      expandedLeafId: string | null
      chatLeafId?: string | null
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
