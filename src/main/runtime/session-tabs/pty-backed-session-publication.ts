import type { OrcaRuntimeWithTouchMobileSessionTabsForWorktree as TouchMobileSessionTabsForWorktreeMethods } from './mobile-session-membership'
import { OrcaRuntimeWithHasLiveOrPersistedServeOrSshOwnedPtyBinding } from '../session-lifecycle/close/has-live-or-persisted-serve-or-ssh-owned-pty-binding'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import { normalizeCompatibleAgentTitleForOwner } from '../../../shared/agent-title-owner'
import { getLatestPtyTitle } from '../runtime-worktree-status-projection'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-types'
import {
  buildMaterializedHeadlessParentLayout,
  getHeadlessMobileSessionGroupId
} from '../mobile-session-layout-projection'
import {
  appendChatTabOrder,
  mergeMobileSessionSnapshotTabs,
  mergeMobileSessionTabGroups
} from '../mobile-session-tab-merge'

export abstract class OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal extends OrcaRuntimeWithHasLiveOrPersistedServeOrSshOwnedPtyBinding {
  protected abstract markPaneLiveTitlesDirty(): void
  protected abstract isMobileSessionSurfaceMembershipAllowed(
    ...args: Parameters<
      TouchMobileSessionTabsForWorktreeMethods['isMobileSessionSurfaceMembershipAllowed']
    >
  ): ReturnType<TouchMobileSessionTabsForWorktreeMethods['isMobileSessionSurfaceMembershipAllowed']>

  abstract touchMobileSessionTabsForWorktree(
    ...args: Parameters<
      TouchMobileSessionTabsForWorktreeMethods['touchMobileSessionTabsForWorktree']
    >
  ): ReturnType<TouchMobileSessionTabsForWorktreeMethods['touchMobileSessionTabsForWorktree']>

  /**
   * Publishes a PTY-backed terminal tab snapshot to the synced mobile session,
   * normalizing Pi-compatible titles based on launch or foreground ownership.
   */
  protected publishPtyBackedMobileSessionTerminal(
    worktreeId: string,
    pty: RuntimePtyWorktreeRecord,
    args: {
      tabId: string
      leafId: string
      title: string | null
      activate: boolean
      selectIfNoActiveTab?: boolean
      startupCwd?: string
      viewMode?: 'terminal' | 'chat'
      split?: { splitFromLeafId: string; direction: 'horizontal' | 'vertical' }
      notify?: boolean
    }
  ): void {
    if (
      !this.isMobileSessionSurfaceMembershipAllowed(worktreeId, args.tabId, args.leafId, pty.ptyId)
    ) {
      return
    }
    const existing = this.mobileSessionTabsByWorktree.get(worktreeId)
    const ownerAgent = pty.launchAgent ?? pty.foregroundAgent
    const title = normalizeCompatibleAgentTitleForOwner(
      args.title ?? getLatestPtyTitle(this.getPtyDisplayRecord(pty)) ?? 'Terminal',
      ownerAgent,
      { ownerIsLaunch: Boolean(pty.launchAgent) }
    )
    const existingTab = existing?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionTerminalTab =>
        candidate.type === 'terminal' &&
        candidate.parentTabId === args.tabId &&
        candidate.leafId === args.leafId
    )
    // Splits inherit parent layout from a sibling surface, not this new leaf's empty surface.
    const baseLayout = args.split
      ? (existing?.tabs.find(
          (candidate): candidate is RuntimeMobileSessionTerminalTab =>
            candidate.type === 'terminal' &&
            candidate.parentTabId === args.tabId &&
            candidate.leafId === args.split!.splitFromLeafId
        )?.parentLayout ?? existingTab?.parentLayout)
      : existingTab?.parentLayout
    const parentLayout = buildMaterializedHeadlessParentLayout(
      args.leafId,
      pty.ptyId,
      baseLayout,
      args.split
    )
    // Rescue/split publication must preserve explicit tab mode before renderer graph catch-up.
    const viewMode =
      args.viewMode ??
      existingTab?.viewMode ??
      existing?.tabs.find(
        (candidate): candidate is RuntimeMobileSessionTerminalTab =>
          candidate.type === 'terminal' &&
          candidate.parentTabId === args.tabId &&
          candidate.viewMode !== undefined
      )?.viewMode
    // Republished tabs retain manual names; new split leaves inherit them.
    const customTitle = (
      existingTab ??
      existing?.tabs.find(
        (candidate): candidate is RuntimeMobileSessionTerminalTab =>
          candidate.type === 'terminal' &&
          candidate.parentTabId === args.tabId &&
          candidate.customTitle !== undefined
      )
    )?.customTitle
    const tab: RuntimeMobileSessionTerminalTab = {
      type: 'terminal',
      id: `${args.tabId}::${args.leafId}`,
      parentTabId: args.tabId,
      leafId: args.leafId,
      ptyId: pty.ptyId,
      incarnationId: pty.incarnationId,
      title,
      ...(customTitle !== undefined ? { customTitle } : {}),
      ...(pty.launchAgent ? { launchAgent: pty.launchAgent } : {}),
      ...(args.startupCwd ? { startupCwd: args.startupCwd } : {}),
      ...(viewMode ? { viewMode } : {}),
      parentLayout,
      isActive:
        args.activate || (args.selectIfNoActiveTab !== false && existing?.activeTabId == null)
    }
    const existingTabs = (existing?.tabs ?? []).filter(
      (candidate) =>
        !(
          candidate.type === 'terminal' &&
          candidate.parentTabId === args.tabId &&
          candidate.leafId === args.leafId
        )
    )
    const tabs = mergeMobileSessionSnapshotTabs(
      existingTabs.map((candidate) => ({
        ...candidate,
        // Update every sibling's parentLayout; clients pick one sibling to render, so stale trees can reverse split direction.
        ...(args.split && candidate.type === 'terminal' && candidate.parentTabId === args.tabId
          ? { parentLayout }
          : {}),
        isActive: tab.isActive ? false : candidate.isActive
      })),
      [tab]
    )
    const activeTab =
      (tab.isActive ? tab : tabs.find((candidate) => candidate.id === existing?.activeTabId)) ??
      tabs.find((candidate) => candidate.isActive) ??
      (args.selectIfNoActiveTab !== false ? tabs[0] : null) ??
      null
    const next: RuntimeMobileSessionTabsSnapshot = {
      worktree: worktreeId,
      publicationEpoch:
        existing?.publicationEpoch ?? `headless:pty-backed:${Date.now().toString(36)}`,
      snapshotVersion: (existing?.snapshotVersion ?? 0) + 1,
      activeGroupId: existing?.activeGroupId ?? getHeadlessMobileSessionGroupId(worktreeId),
      activeTabId: activeTab?.id ?? null,
      activeTabType: activeTab?.type ?? null,
      tabGroups: appendChatTabOrder(
        mergeMobileSessionTabGroups(
          worktreeId,
          existing?.tabGroups ?? [],
          tabs,
          activeTab?.type === 'terminal' ? activeTab : null
        ),
        existing?.tabGroups ?? [],
        tabs,
        activeTab?.id ?? null
      ),
      ...(existing?.tabGroupLayout ? { tabGroupLayout: existing.tabGroupLayout } : {}),
      tabs
    }
    this.storeMobileSessionSnapshot(worktreeId, next)
    if (args.notify !== false) {
      this.notifyMobileSessionTabsChanged(worktreeId)
    }
  }

  protected touchMobileSessionSnapshotsForPty(
    ptyId: string,
    options: { immediate?: boolean } = {}
  ): void {
    // All visible title/foreground/bind updates pass here; apply phone pane-title rules consistently.
    this.markPaneLiveTitlesDirty()
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      const hasPtyBackedTab = snapshot.tabs.some(
        (tab) =>
          tab.type === 'terminal' &&
          (tab.ptyId === ptyId || tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] === ptyId)
      )
      if (!hasPtyBackedTab) {
        continue
      }
      this.touchMobileSessionTabsForWorktree(worktreeId, options)
    }
  }

  protected getMobileSessionWorktreeIdsForPty(ptyId: string): string[] {
    const worktreeIds: string[] = []
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      const hasPtyBackedTab = snapshot.tabs.some(
        (tab) =>
          tab.type === 'terminal' &&
          (tab.ptyId === ptyId || tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId] === ptyId)
      )
      if (hasPtyBackedTab) {
        worktreeIds.push(worktreeId)
      }
    }
    return worktreeIds
  }
}
