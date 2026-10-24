import type { OrcaRuntimeWithPruneMobileSessionTabGroupLayout as PruneMobileSessionTabGroupLayoutMethods } from '../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import type { RuntimeHeadlessTabGroups as HeadlessTabGroupsMethods } from './headless-tab-group-moves'
import { OrcaRuntimeWithCloseMobileSessionTab } from '../session-lifecycle/close/close-mobile-session-tab'
import type {
  BrowserTabInfo,
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import { getMobileSessionSnapshotTabIdentityKeys } from '../mobile-session-tab-merge'
import type { BrowserSessionTabSelectionOptions } from '../browser-tab-create-publication'
import { getRuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'
import { applyBrowserSessionTabSelection } from '../browser-session-tab-selection-snapshot'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionCloseCause } from '../../native-chat/agent-session-wire/structured-agent-session-host-lifetime'
import { retireStructuredAgentSessionTabFrom } from '../structured-agent-session-tab-retirement'
import {
  chatTabId,
  withChatTabChanges,
  type ChatTabChange,
  type ChatTabPlacement
} from '../agent-session-tab-layout'
import { createChatTabLayoutQueue } from '../agent-session-tab-layout-queue'
import type { WindowLayoutCommand } from '../runtime-layout-apply'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { savedSessionId } from '../saved-structured-agent-session-restoration'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { structuredSessionTabRetired } from '../structured-worker-custody'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'

export abstract class OrcaRuntimeWithCloseStructuredAgentSessionTab extends OrcaRuntimeWithCloseMobileSessionTab {
  protected abstract getListedBrowserTabsByPageId(worktreeId: string): Map<string, BrowserTabInfo>
  protected abstract getMobileTerminalLeafPtyIds(
    ...args: Parameters<PruneMobileSessionTabGroupLayoutMethods['getMobileTerminalLeafPtyIds']>
  ): ReturnType<PruneMobileSessionTabGroupLayoutMethods['getMobileTerminalLeafPtyIds']>

  protected abstract getMobileTerminalPaneKey(
    ...args: Parameters<PruneMobileSessionTabGroupLayoutMethods['getMobileTerminalPaneKey']>
  ): ReturnType<PruneMobileSessionTabGroupLayoutMethods['getMobileTerminalPaneKey']>

  abstract applyLayoutCommand(command: WindowLayoutCommand): Promise<LayoutApplyReply>

  protected abstract persistHeadlessTabGroups(
    ...args: Parameters<HeadlessTabGroupsMethods['persistHeadlessTabGroups']>
  ): ReturnType<HeadlessTabGroupsMethods['persistHeadlessTabGroups']>

  protected async closeStructuredAgentSessionTab(
    tab: RuntimeMobileSessionAgentTab,
    cause: StructuredAgentSessionCloseCause
  ): Promise<void> {
    const host = getStructuredAgentSessionHost()
    if (host) {
      if (typeof host.setSessionTabVisibility === 'function') {
        // The restore index is bookkeeping: one that cannot be written (a newer Orca's records, a
        // failing disk) is reported, and the tab still closes.
        await host.setSessionTabVisibility(tab.sessionId, false).catch((error: unknown) => {
          host.deps.logger.warn('recording a closed chat tab failed', {
            scope: 'tab-visibility-close',
            sessionId: tab.sessionId,
            error
          })
        })
      }
    }
    // Retire durable visibility and the runtime snapshot before stopping the provider.
    this.retireStructuredAgentSessionTabFromSnapshot(tab.sessionId)
    if (typeof host?.close === 'function') {
      await host.close(tab.sessionId, cause)
    }
  }

  /**
   * Prunes a structured session's chat tab from whichever worktree snapshot still carries it.
   *
   * Public because orchestration settles structured workers outside the tab surface: stop, release
   * and the half-started discard all prove their own close and then have to retire the tab that
   * `publishStructuredAgentSessionTab` put on screen. `setSessionTabVisibility(false)` only clears
   * the DURABLE restore index, so without this the dead chat tab survives for the rest of the app
   * session and re-attaches the released session when opened.
   *
   * Snapshot-only and renderer-free: it never asks the renderer to close anything, so it is safe on
   * the startup release reconciler where no renderer exists.
   */
  retireStructuredAgentSessionTabFromSnapshot(sessionId: string): boolean {
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      const nextSnapshot = retireStructuredAgentSessionTabFrom(snapshot, sessionId)
      if (!nextSnapshot) {
        continue
      }
      this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
      this.emitMobileSessionTabsSnapshot(nextSnapshot)
      return true
    }
    return false
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
      this.getListedBrowserTabsByPageId(snapshot.worktree).has(tab.browserPageId)
    )
  }

  // Public so runtime-side page release (lease fencing) can prune a tab whose page is gone.
  retireRuntimeOwnedBrowserSessionTab(worktreeId: string, browserPageId: string): boolean {
    // A saved tab is a row clients list even before its page starts.
    const savedTabClosed = this.serveBrowserTabs.closed(worktreeId, browserPageId)
    // Why: before the snapshot guard — worktree removal drops the snapshot first, and the host
    // rows for its client pages would otherwise be stranded on screen with nothing to retract them.
    this.clientHostedBrowserRows.publish(worktreeId)
    this.persistClientHostedBrowserPagesForWorktree(worktreeId)
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return savedTabClosed
    }
    const retiredTab = snapshot.tabs.find(
      (candidate): candidate is RuntimeMobileSessionBrowserTab =>
        candidate.type === 'browser' && candidate.browserPageId === browserPageId
    )
    if (!retiredTab) {
      return savedTabClosed
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
      focusesHost
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

  /** Saves a chat's tab in a windowless host's layout, where it is listed from once read there. */
  protected saveWindowlessAgentSessionTab(
    worktreeId: string,
    chat: { sessionId: string; agent: StructuredAgentId; placement?: ChatTabPlacement }
  ): void {
    this.changeWindowlessChatTabs(worktreeId, [
      { open: { ...chat, tabId: chatTabId(chat.sessionId) } }
    ])
  }

  /**
   * Removes a chat's saved tab once the index no longer lists it. Called from the index's hidden
   * notice, which every chat close reaches; a close that put the tab back keeps it.
   */
  protected removeWindowlessAgentSessionTab(sessionId: string): void {
    const host = getStructuredAgentSessionHost()
    if (!host || !structuredSessionTabRetired(host, sessionId)) {
      return
    }
    // Switch point: main reads which worktrees show the chat when its queue reaches the close, so
    // an open still queued ahead of it is closed too.
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      this.queueChatTabChanges(() =>
        this.worktreesShowingSavedChat(sessionId).map((worktreeId) => ({
          worktreeId,
          change: { close: sessionId }
        }))
      )
      return
    }
    for (const worktreeId of this.worktreesShowingSavedChat(sessionId)) {
      this.changeWindowlessChatTabs(worktreeId, [{ close: sessionId }])
    }
  }

  private worktreesShowingSavedChat(sessionId: string): string[] {
    const saved = this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)?.unifiedTabs ?? {}
    return Object.entries(saved).flatMap(([worktreeId, tabs]) =>
      tabs.some((tab) => savedSessionId(tab) === sessionId) ? [worktreeId] : []
    )
  }

  // A window saves its own layout whole, chat tabs included; only a host with none saves them here.
  protected changeWindowlessChatTabs(worktreeId: string, changes: readonly ChatTabChange[]): void {
    // Switch point: main places a chat's tab in its own layout, with or without a window.
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      this.queueChatTabChanges(() => changes.map((change) => ({ worktreeId, change })))
      return
    }
    const session = this.getAvailableAuthoritativeWindow()
      ? null
      : this.getWorkspaceSessionForWorktree(worktreeId)
    const next =
      session &&
      withChatTabChanges(
        this.getWorkspaceSessionHostIdForWorktree(worktreeId),
        session,
        worktreeId,
        changes
      )
    if (next) {
      this.setWorkspaceSessionForWorktree(worktreeId, next)
    }
  }

  private readonly queueChatTabChanges = createChatTabLayoutQueue({
    sessionOf: (worktreeId) => this.getWorkspaceSessionForWorktree(worktreeId),
    hostIdOf: (worktreeId) => this.getWorkspaceSessionHostIdForWorktree(worktreeId),
    apply: (command) => this.applyLayoutCommand(command)
  })
}
