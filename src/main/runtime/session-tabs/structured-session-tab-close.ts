import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab as BrowserOwnership } from './mobile-session-publication-preservation'
import type { OrcaRuntimeWithPruneMobileSessionTabGroupLayout as PruneMobileSessionTabGroupLayoutMethods } from '../session-lifecycle/projection/prune-mobile-session-tab-group-layout'
import type { RuntimeHeadlessTabGroups as HeadlessTabGroupsMethods } from './headless-tab-group-moves'
import { OrcaRuntimeWithStructuredSessionTabProjection } from './restored-chat-tab-changes'
import type {
  BrowserTabInfo,
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionRetiredTerminalSurface,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-types'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'
import type { BrowserSessionTabSelectionOptions } from '../browser-tab-create-publication'
import { getRuntimeBrowserPageRegistry } from '../runtime-browser-page-registry'
import { applyBrowserSessionTabSelection } from '../browser-session-tab-selection-snapshot'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionCloseCause } from '../../native-chat/agent-session-wire/structured-agent-session-host-lifetime'
import {
  chatTabId,
  withChatTabChanges,
  type ChatTabChange
} from '../agent-session/agent-session-tab-layout'
import { createChatTabLayoutQueue } from '../agent-session-tab-layout-queue'
import type { WindowLayoutCommand, LayoutCommandRunOptions } from '../runtime-layout-apply'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import {
  captureStructuredSessionPresentation,
  capturedStructuredSessionSavedTabChanges,
  windowlessStructuredSessionTabSaveEligible
} from './structured-session-tab-presentation'
import type { StructuredSessionTabPublicationInput as ChatPublication } from './structured-session-tab-publication'
import {
  closeCapturedStructuredSession,
  type StructuredSessionSurface
} from '../agent-session/structured-agent-session-close'

export abstract class OrcaRuntimeWithCloseStructuredAgentSessionTab extends OrcaRuntimeWithStructuredSessionTabProjection {
  protected abstract isHeadlessOwnedMobileBrowserTab(
    ...args: Parameters<BrowserOwnership['isHeadlessOwnedMobileBrowserTab']>
  ): ReturnType<BrowserOwnership['isHeadlessOwnedMobileBrowserTab']>
  protected abstract getMobileSessionPublicationEpochAfterHeadlessBrowserClose(
    ...args: Parameters<
      BrowserOwnership['getMobileSessionPublicationEpochAfterHeadlessBrowserClose']
    >
  ): ReturnType<BrowserOwnership['getMobileSessionPublicationEpochAfterHeadlessBrowserClose']>
  protected abstract getListedBrowserTabsByPageId(worktreeId: string): Map<string, BrowserTabInfo>
  protected abstract getMobileTerminalLeafPtyIds(
    ...args: Parameters<PruneMobileSessionTabGroupLayoutMethods['getMobileTerminalLeafPtyIds']>
  ): ReturnType<PruneMobileSessionTabGroupLayoutMethods['getMobileTerminalLeafPtyIds']>

  protected abstract getMobileTerminalPaneKey(
    ...args: Parameters<PruneMobileSessionTabGroupLayoutMethods['getMobileTerminalPaneKey']>
  ): ReturnType<PruneMobileSessionTabGroupLayoutMethods['getMobileTerminalPaneKey']>

  abstract applyLayoutCommand(
    command: WindowLayoutCommand,
    run?: Pick<LayoutCommandRunOptions, 'admit'>
  ): Promise<LayoutApplyReply>

  protected abstract persistHeadlessTabGroups(
    ...args: Parameters<HeadlessTabGroupsMethods['persistHeadlessTabGroups']>
  ): ReturnType<HeadlessTabGroupsMethods['persistHeadlessTabGroups']>

  protected async closeStructuredAgentSessionTab(
    tab: RuntimeMobileSessionAgentTab,
    cause: StructuredAgentSessionCloseCause,
    surface: StructuredSessionSurface | null
  ): Promise<boolean> {
    const host = getStructuredAgentSessionHost()
    if (!host) {
      return false
    }
    return closeCapturedStructuredSession(host, tab.sessionId, cause, surface, this)
  }

  // Refused echo closes need a newer snapshot so clients restore the still-live mirror they already pruned.
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
    // After main teardown, renderer relay is advisory and cannot block flush or fail the close.
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
    return this.isHeadlessOwnedMobileBrowserTab(snapshot, tab)
  }

  // Public so runtime-side page release (lease fencing) can prune a tab whose page is gone.
  retireRuntimeOwnedBrowserSessionTab(worktreeId: string, browserPageId: string): boolean {
    // A saved tab is a row clients list even before its page starts.
    const savedTabClosed = this.serveBrowserTabs.closed(worktreeId, browserPageId)
    // Retract client-page rows before the snapshot guard; worktree removal may already have dropped the snapshot.
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
      publicationEpoch: this.getMobileSessionPublicationEpochAfterHeadlessBrowserClose(snapshot),
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
    // Client-placed pages use the registry, not offscreen backing.
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
    // Persist browser groups or later rebuilds coalesce them left.
    if (placedInTargetGroup && nextSnapshot.tabGroupLayout) {
      this.persistHeadlessTabGroups(worktreeId, nextGroups, nextSnapshot.tabGroupLayout)
    }
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    if (options.caller) {
      // Keep shared selection; only the originating client selects its newly created tab. Local creates lack a caller.
      this.applyMobileSessionTabNavigation(
        this.getMobileSessionTabsForWorktree(worktreeId),
        tab.id,
        options.caller.navigation,
        options.caller.clientNavigationId,
        options.caller.follows
      )
    }
  }

  /** Saves a chat's tab in a windowless host's layout, where it is listed from once read there. */
  protected saveWindowlessAgentSessionTab(
    worktreeId: string,
    chat: Pick<ChatPublication, 'sessionId' | 'agent' | 'placement' | 'tabId'> & {
      eligible?: () => boolean
    }
  ): Promise<void> {
    const tabId = chat.tabId ?? chatTabId(chat.sessionId)
    return this.changeWindowlessChatTabs(
      worktreeId,
      [{ open: { ...chat, tabId } }],
      () =>
        chat.eligible?.() !== false &&
        windowlessStructuredSessionTabSaveEligible(
          chat.sessionId,
          tabId,
          this.getWorkspaceSessionForWorktree(worktreeId),
          worktreeId
        )
    )
  }

  captureStructuredAgentSessionPresentation(sessionId: string) {
    return captureStructuredSessionPresentation(sessionId, {
      raw: this.currentLocalStructuredSessionPresentation(sessionId),
      saved: this.store?.getWorkspaceSession?.(LOCAL_EXECUTION_HOST_ID)?.unifiedTabs ?? {},
      pending: this.queueChatTabChanges.pendingOpens()
    })
  }

  removeCapturedStructuredSessionSavedTabs(
    sessionId: string,
    targets: readonly { worktreeId: string; tabId: string }[]
  ): void {
    const changesNow = capturedStructuredSessionSavedTabChanges(sessionId, targets, {
      sessionOf: (id) => this.getWorkspaceSessionForWorktree(id),
      currentRaw: () => this.currentLocalStructuredSessionPresentation(sessionId),
      eligible: () => this.passiveStructuredSessionTabChangeEligible({ close: sessionId })
    })
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      this.queueChatTabChanges(changesNow)
    } else {
      for (const queued of changesNow()) {
        this.changeWindowlessChatTabs(queued.worktreeId, [queued.change], queued.eligible)
      }
    }
  }

  // A window saves its own layout whole, chat tabs included; only a host with none saves them here.
  protected changeWindowlessChatTabs(
    worktreeId: string,
    changes: readonly ChatTabChange[],
    eligible?: (change: ChatTabChange) => boolean
  ): Promise<void> {
    // Main-owned layouts place chat tabs with or without a window.
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      return this.queueChatTabChanges(
        changes.map((change) => ({
          worktreeId,
          change,
          ...(eligible ? { eligible: () => eligible(change) } : {})
        }))
      )
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
        eligible ? changes.filter(eligible) : changes
      )
    if (next) {
      this.setWorkspaceSessionForWorktree(worktreeId, next)
    }
    return Promise.resolve()
  }

  private readonly queueChatTabChanges = createChatTabLayoutQueue({
    sessionOf: (worktreeId) => this.getWorkspaceSessionForWorktree(worktreeId),
    hostIdOf: (worktreeId) => this.getWorkspaceSessionHostIdForWorktree(worktreeId),
    apply: (command, run) => this.applyLayoutCommand(command, run)
  })
}
