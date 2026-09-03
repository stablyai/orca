// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCloseMobileSessionTab } from './orca-runtime-close-mobile-session-tab'
import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { getMobileSessionSnapshotTabIdentityKeys } from './mobile-session-tab-merge'
import type { BrowserSessionTabSelectionOptions } from './browser-tab-create-publication'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import { applyBrowserSessionTabSelection } from './browser-session-tab-selection-snapshot'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

export class OrcaRuntimeWithCloseStructuredAgentSessionTab extends OrcaRuntimeWithCloseMobileSessionTab {
  protected async closeStructuredAgentSessionTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionAgentTab
  ): Promise<void> {
    const host = getStructuredAgentSessionHost()
    if (host) {
      if (typeof host.setSessionTabVisibility === 'function') {
        await host.setSessionTabVisibility(tab.sessionId, false)
      }
    }
    const nextTabs = snapshot.tabs.filter((candidate) => candidate.id !== tab.id)
    const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabGroups: (snapshot.tabGroups ?? []).map((group) => ({
        ...group,
        tabOrder: group.tabOrder.filter((id) => id !== tab.id),
        activeTabId: group.activeTabId === tab.id ? null : group.activeTabId,
        recentTabIds: group.recentTabIds?.filter((id) => id !== tab.id)
      })),
      tabs: nextTabs
    }
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    // Retire durable visibility and the runtime snapshot before stopping the provider.
    if (typeof host?.close === 'function') {
      await host.close(tab.sessionId)
    }
  }

  // Why: a refused echoed close means the echoing client already pruned its
  // local mirror. Bump the version and emit the unchanged snapshot so clients
  // that dedupe by snapshotVersion re-add and re-attach the still-live tab.
  protected republishMobileSessionTabsSnapshot(worktreeId: string): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (snapshot) {
      this.storeMobileSessionSnapshot(worktreeId, {
        ...snapshot,
        snapshotVersion: snapshot.snapshotVersion + 1
      })
    }
    this.notifyMobileSessionTabsChanged(worktreeId)
  }

  protected getMobileSessionTerminalHandle(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): string | null {
    const pty = this.findPtyForMobileTerminalTab(worktreeId, tab)
    if (!pty) {
      return null
    }
    return this.handleByPtyId.get(pty.ptyId) ?? this.findHandleForPtyRecord(pty.ptyId)
  }

  protected getMobileSessionTerminalRetirementProof(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    authorizedPty?: RuntimePtyWorktreeRecord
  ): RuntimeMobileSessionRetiredTerminalSurface | null {
    const pty = this.findPtyForMobileTerminalTab(worktreeId, tab) ?? authorizedPty ?? null
    if (!pty || !this.getMobileTerminalLeafPtyIds(tab).includes(pty.ptyId)) {
      return null
    }
    const terminal = this.handleByPtyId.get(pty.ptyId) ?? this.findHandleForPtyRecord(pty.ptyId)
    if (!terminal) {
      return null
    }
    const incarnationId =
      pty.incarnationId ??
      this.getWorkspaceSessionForWorktree(worktreeId)?.terminalPtyIncarnationsByPaneKey?.[
        this.getMobileTerminalPaneKey(tab)
      ]
    return {
      parentTabId: tab.parentTabId,
      leafId: tab.leafId,
      ptyId: pty.ptyId,
      terminal,
      ...(incarnationId ? { incarnationId } : {})
    }
  }

  protected notifyRendererOfHeadlessTerminalClose(parentTabId: string): void {
    // Why: this relay is advisory after main owns teardown; renderer failure must
    // not prevent the authoritative session flush or turn the close into failure.
    try {
      this.notifier?.closeTerminal(parentTabId)
    } catch (error) {
      console.warn('[runtime] failed to notify renderer after headless terminal close', {
        parentTabId,
        error
      })
    }
  }

  protected isOffscreenMobileSessionBrowserTab(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    tab: RuntimeMobileSessionBrowserTab
  ): boolean {
    if (!this.offscreenBrowserBackend || !tab.browserPageId) {
      return false
    }
    if (this.isHeadlessBuiltMobileSessionPublicationBase(snapshot.publicationEpoch)) {
      return true
    }
    const accepted = this.acceptedRendererMobileSnapshotByWorktree.get(snapshot.worktree)
    return (
      snapshot.publicationEpoch.includes(':headless-merge:') &&
      accepted !== undefined &&
      !getMobileSessionSnapshotTabIdentityKeys(tab).some((id) =>
        accepted.rendererTabIdentityKeys.has(id)
      ) &&
      this.getLiveBrowserTabsByPageId(snapshot.worktree).has(tab.browserPageId)
    )
  }

  // Public so runtime-side page release (lease fencing) can prune a tab whose page is gone.
  retireRuntimeOwnedBrowserSessionTab(worktreeId: string, browserPageId: string): boolean {
    // Why: before the snapshot guard — worktree removal drops the snapshot first, and the host
    // rows for its client pages would otherwise be stranded on screen with nothing to retract them.
    this.clientHostedBrowserRows.publish(worktreeId)
    this.persistClientHostedBrowserPagesForWorktree(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return false
    }
    const retiredTab = snapshot.tabs.find(
      (candidate): candidate is RuntimeMobileSessionBrowserTab =>
        candidate.type === 'browser' && candidate.browserPageId === browserPageId
    )
    if (!retiredTab) {
      return false
    }
    const nextTabs = snapshot.tabs.filter((candidate) => candidate.id !== retiredTab.id)
    const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabGroups: (snapshot.tabGroups ?? []).map((group) => ({
        ...group,
        tabOrder: group.tabOrder.filter((id) => id !== retiredTab.id),
        activeTabId: group.activeTabId === retiredTab.id ? null : group.activeTabId
      })),
      tabs: nextTabs
    }
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    return true
  }

  protected markHeadlessBrowserSessionTabActive(
    worktreeId: string | undefined,
    browserPageId: string,
    options: BrowserSessionTabSelectionOptions
  ): void {
    if (!worktreeId) {
      return
    }
    const { targetGroupId, focusesHost } = options
    // Why: client-placed pages publish through the page registry and need no offscreen backing.
    if (
      !this.offscreenBrowserBackend &&
      !getRuntimeBrowserPageRegistry(this).getPage(browserPageId)
    ) {
      return
    }
    // Hydrate first so the freshly created browser tab is present in the snapshot.
    this.hydrateHeadlessMobileSessionTabsFromWorkspaceSession(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionBrowserTab =>
        candidate.type === 'browser' && candidate.browserPageId === browserPageId
    )
    if (!snapshot || !tab) {
      return
    }
    const {
      snapshot: nextSnapshot,
      groups: nextGroups,
      placedInTargetGroup
    } = applyBrowserSessionTabSelection({
      snapshot,
      tabId: tab.id,
      ...(targetGroupId !== undefined ? { targetGroupId } : {}),
      focusesHost,
      publicationEpoch: `headless:${Date.now().toString(36)}`
    })
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    // Why: browser group membership is otherwise live-only; persist it so a
    // later rebuild keeps the browser in its group instead of coalescing left.
    if (placedInTargetGroup && nextSnapshot.tabGroupLayout) {
      this.persistHeadlessTabGroups(worktreeId, nextGroups, nextSnapshot.tabGroupLayout)
    }
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    if (options.caller) {
      // Why: the originating device still lands on the tab it just created; only the shared
      // snapshot stayed put. Local creates keep the pre-navigation shape by having no caller.
      this.applyMobileSessionTabNavigation(
        this.getMobileSessionTabsForWorktree(worktreeId),
        tab.id,
        options.caller.navigation,
        options.caller.clientNavigationId
      )
    }
  }
}
