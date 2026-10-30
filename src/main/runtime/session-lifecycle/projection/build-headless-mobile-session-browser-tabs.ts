import { windowListsTab } from '../../terminal/surface/main-terminal-surfaces'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { matchesTerminalSurfaceCapture } from '../../../../shared/terminal-tab-close'
import { OrcaRuntimeWithTerminalSurfaceCloseCommit } from '../../session-tabs/terminal-surface-close-commit'
import type { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab as BrowserOwnership } from '../../session-tabs/mobile-session-publication-preservation'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/runtime-types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { getRuntimeBrowserPageRegistry } from '../../runtime-browser-page-registry'
import { holdAgentSessionInventory } from '../../structured-agent-session-inventory-hold'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalPaneCloseTarget } from '../../../../shared/terminal-surface-close-target'
import { retireTerminalSurfacesFromSnapshot } from '../../mobile-session-terminal-retirement'
import type { PtyControllerInventory } from '../../runtime-pty-controller-contract'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { markAgentLaunchesClosedByUser } from '../../../agent-launch/agent-launch-pane-attachment'

import type { TerminalPaneRetirementOptions } from '../../mobile-session-tab-close-outcome'

export abstract class OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs extends OrcaRuntimeWithTerminalSurfaceCloseCommit {
  protected abstract getRendererOwnedBrowserPageIds(
    ...args: Parameters<BrowserOwnership['getRendererOwnedBrowserPageIds']>
  ): ReturnType<BrowserOwnership['getRendererOwnedBrowserPageIds']>
  // Why: headless serve backs browser panes with offscreen WebContents that live
  // only in the BrowserManager, never in a renderer graph. Without surfacing them
  // as session tabs, a session.tabs snapshot (e.g. on terminal open) prunes the
  // paired browser tab and closing it fails with tab_not_found. Synthesize browser
  // session tabs from the live bridge so they are first-class alongside terminals.
  protected buildHeadlessMobileSessionBrowserTabs(
    worktreeId: string
  ): RuntimeMobileSessionBrowserTab[] {
    const backend = this.offscreenBrowserBackend
    const rendererPageIds = this.getRendererOwnedBrowserPageIds(worktreeId)
    // Saved tabs whose page starts on first use are listed as running ones are.
    const serverTabs =
      backend && this.agentBrowserBridge?.tabList
        ? [
            ...this.agentBrowserBridge
              .tabList(worktreeId)
              .tabs.filter((tab) => backend.ownsTab(tab.browserPageId)),
            ...this.serveBrowserTabs.listUnstarted(worktreeId)
          ].filter((tab) => !rendererPageIds.has(tab.browserPageId))
        : []
    const publishedServerTabs = serverTabs.map((tab) => {
      const persistedProps = this.getPersistedUnifiedSessionTabProps(
        worktreeId,
        this.serveBrowserTabs.unifiedTabId(worktreeId, tab.browserPageId)
      )
      return {
        type: 'browser' as const,
        // Offscreen pages lack separate workspace identity; use page id like the server browserWorkspaceId fallback.
        id: tab.browserPageId,
        title: tab.title || tab.url || 'Browser',
        browserWorkspaceId: tab.browserPageId,
        browserPageId: tab.browserPageId,
        browserProfileId: tab.profileId ?? undefined,
        url: tab.url || 'about:blank',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        loadError: tab.loadError ?? undefined,
        certificateFailure: tab.certificateFailure ?? undefined,
        ...(persistedProps ? { color: persistedProps.color } : {}),
        ...(persistedProps ? { isPinned: persistedProps.isPinned === true } : {}),
        isActive: tab.active === true
      }
    })
    const publishedClientTabs = getRuntimeBrowserPageRegistry(this)
      .listPages(worktreeId)
      .map((page) => ({
        type: 'browser' as const,
        id: page.browserPageId,
        title: page.title || page.url || 'Browser',
        browserWorkspaceId: page.browserPageId,
        browserPageId: page.browserPageId,
        browserProfileId: page.browserProfileId,
        executionHostKey: page.executionHostKey,
        placement: page.placement,
        url: page.url,
        loading: page.loading,
        canGoBack: page.canGoBack,
        canGoForward: page.canGoForward,
        isActive: page.active
      }))
    return [...publishedServerTabs, ...publishedClientTabs]
  }

  protected getPersistedUnifiedSessionTabProps(
    worktreeId: string,
    tabId: string
  ): Pick<Tab, 'color' | 'isPinned'> | null {
    const tab =
      this.getWorkspaceSessionForWorktree(worktreeId)?.unifiedTabs?.[worktreeId]?.find(
        (candidate) => candidate.id === tabId || candidate.entityId === tabId
      ) ?? null
    return tab ? { color: tab.color, isPinned: tab.isPinned } : null
  }

  /**
   * Commits a split pane's close that main started, then tells the desktop renderer to drop that
   * pane. Never touches the tab: a pane the session no longer lists commits nothing.
   */
  protected async closeTerminalPane(
    worktreeId: string,
    target: TerminalPaneCloseTarget,
    options: TerminalPaneRetirementOptions = {}
  ): Promise<boolean> {
    let closedTab = false
    if (
      options.originalPresentation &&
      !this.originalTerminalExecutionMatches(options.originalPresentation.identity)
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    if (
      options.originalPresentation &&
      !options.presentationRetired &&
      (options.rendererOwnsPresentation || windowListsTab(this, this.tabs, target.tabId))
    ) {
      if (!this.notifier?.closeTerminalTab) {
        throw new Error('runtime_unavailable')
      }
      await this.notifier.closeTerminalTab(target.tabId, {
        localPtyTeardownOwnedExternally: true,
        originalSurface: options.originalPresentation.identity
      })
    }
    // An explicit close (a phone's, the CLI's): a launch still starting or delivering there stops.
    if (!options.originalPresentation) {
      markAgentLaunchesClosedByUser(worktreeId, target)
    }
    try {
      if (options.presentationRetired && ORCA_LAYOUT_OWNER_IS_MAIN) {
        closedTab = true
      } else if (ORCA_LAYOUT_OWNER_IS_MAIN && options.originalPresentation) {
        const reply = await this.applyLayoutCommand(
          {
            type: 'closePane',
            workspace: worktreeId,
            tabId: target.tabId,
            leafId: target.leafId
          },
          {
            originalPresentation: options.originalPresentation,
            admit: () =>
              this.originalTerminalExecutionMatches(options.originalPresentation!.identity)
          }
        )
        if (!reply.ok) {
          throw new Error(reply.code)
        }
        closedTab = reply.result.closed?.includes(target.tabId) === true
      } else {
        await this.closeTerminalSurface(worktreeId, target, {
          allowMissing: true,
          ...options,
          onClosed: (tab) => {
            closedTab = tab
          }
        })
      }
    } catch (error) {
      if (
        options.originalPresentation ||
        !(error instanceof Error) ||
        error.message !== 'workspace_session_unavailable'
      ) {
        throw error
      }
    }
    // Why: no exit may ever arrive to remove the pane. The notice is leaf-addressed, so it and the
    // renderer's exit handling are each a no-op after the other.
    this.retireClosedTerminalLeafFromMobileSnapshot(
      worktreeId,
      target.tabId,
      target.leafId,
      options
    )
    if (!options.originalPresentation) {
      this.notifier?.closeTerminalPane?.(target.tabId, target.leafId)
    }
    return closedTab
  }

  /** A paired client's close of one pane: stops only that pane's process, commits only that pane. */
  protected async closeMobileSessionTerminalPane(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): Promise<void> {
    // Failed kill must not retain a pane the user explicitly closed.
    const pty = this.findPtyForMobileTerminalTab(worktreeId, tab)
    if (pty) {
      this.ptyController?.kill(pty.ptyId)
    } else if (!this.tabs.has(tab.parentTabId) && tab.ptyId && parseAppSshPtyId(tab.ptyId)) {
      // Without renderer kill ownership, a dormant SSH pane's durable id is the stop authority.
      this.ptyController?.kill(tab.ptyId)
    }
    await this.closeTerminalPane(worktreeId, {
      kind: 'pane',
      tabId: tab.parentTabId,
      leafId: tab.leafId
    })
  }

  private retireClosedTerminalLeafFromMobileSnapshot(
    worktreeId: string,
    tabId: string,
    leafId: string,
    options: TerminalPaneRetirementOptions = {}
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionTerminalTab =>
        candidate.type === 'terminal' &&
        candidate.parentTabId === tabId &&
        candidate.leafId === leafId
    )
    if (
      options.originalPresentation &&
      (!this.originalTerminalExecutionMatches(options.originalPresentation.identity) ||
        !matchesTerminalSurfaceCapture(
          options.originalPresentation,
          this.getWorkspaceSessionHostIdsForTab(worktreeId, tabId),
          (hostId) => this.store?.getWorkspaceSession?.(hostId)
        ))
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    const original = options.originalPresentation?.identity
    const bound = tab?.ptyId ?? tab?.parentLayout?.ptyIdsByLeafId?.[leafId]
    if (
      original &&
      ((bound && bound !== original.ptyId) ||
        (tab?.incarnationId && tab.incarnationId !== original.incarnationId))
    ) {
      throw new Error('terminal_pane_owner_changed')
    }
    if (original?.ptyId) {
      const pty = this.ptysById.get(original.ptyId)
      if (pty) {
        pty.runtimeSessionOwned = false
      }
      this.setPairedRendererSessionOwnership(original.ptyId, false)
    }
    // A renderer can publish removal while its required durable close is awaiting completion.
    if (!snapshot || !tab || (!original && this.tabs.has(tabId))) {
      if (original) {
        this.publishRetiredTerminalSurfaceProofs(worktreeId, options.retirementProofs ?? [])
      }
      return
    }
    const proof = !original && this.getMobileSessionTerminalRetirementProof(worktreeId, tab)
    const retired = retireTerminalSurfacesFromSnapshot({
      snapshot,
      ptyId: original?.ptyId ?? tab.ptyId ?? tab.parentLayout?.ptyIdsByLeafId?.[leafId] ?? '',
      exactSurfaces: [{ parentTabId: tabId, leafId }],
      exactOnly: true,
      retirementProofs: options.retirementProofs ?? (proof ? [proof] : [])
    })
    if (retired) {
      this.storeMobileSessionSnapshot(worktreeId, retired.snapshot)
      this.notifyMobileSessionTabsChanged(worktreeId)
    }
  }

  protected emitMobileSessionTabsSnapshot(snapshot: RuntimeMobileSessionTabsSnapshot): void {
    if (this.mobileSessionTabListeners.size === 0) {
      return
    }
    const result = this.toMobileSessionTabsResult(snapshot)
    const changeSequence = ++this.mobileSessionTabsChangeSequence
    for (const subscription of this.mobileSessionTabListeners) {
      subscription.listener(
        this.projectMobileSessionTabsForClient(result, subscription.clientNavigationId),
        changeSequence
      )
    }
  }

  /** Recompute this client's reconciliation holds and selection, setting and clearing flags so earlier frames or other clients cannot leak authority. */
  protected projectMobileSessionTabsForClient(
    result: RuntimeMobileSessionTabsResult,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return this.clientSessionTabSelections.project(
      this.withSessionTabsHolds(result, clientNavigationId),
      clientNavigationId
    )
  }

  protected withSessionTabsHolds(result: RuntimeMobileSessionTabsResult, navigationId?: string) {
    const held = this.clientHostedPageReconciliation.holdFor(result, navigationId, Date.now())
    return holdAgentSessionInventory(held, this.structuredAgentSessionInventoryUnverifiable)
  }

  protected async refreshMobileSessionPtyRecords(
    targetWorktreeId: string | null = null
  ): Promise<Set<string> | null> {
    const inventory = await this.refreshMobileSessionPtyInventory(targetWorktreeId)
    return inventory ? new Set(inventory.livePtyIds) : null
  }

  protected async refreshMobileSessionPtyInventory(
    targetWorktreeId: string | null = null
  ): Promise<PtyControllerInventory | null> {
    // Targeted mobile polls must not queue behind an aggregate census that may
    // be waiting on an unrelated SSH provider.
    if (targetWorktreeId !== null && targetWorktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
      return this.performMobileSessionPtyRecordsRefresh(targetWorktreeId)
    }
    if (targetWorktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
      // Fleet-wide refreshes share one aggregate controller inventory.
      const pending = this.pendingMobileSessionPtyAggregateInventoryRefresh
      if (pending) {
        return pending
      }
      // Coalesce reconnect exit bursts into one authoritative daemon inventory instead of one cross-generation RPC per stale tab.
      const refresh = this.performMobileSessionPtyRecordsRefresh(targetWorktreeId).finally(() => {
        if (this.pendingMobileSessionPtyAggregateInventoryRefresh === refresh) {
          this.pendingMobileSessionPtyAggregateInventoryRefresh = null
        }
      })
      this.pendingMobileSessionPtyAggregateInventoryRefresh = refresh
      return refresh
    }
    return await this.performMobileSessionPtyRecordsRefresh(targetWorktreeId)
  }
}
