// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithPersistTerminalSurfaceRetirements } from './orca-runtime-persist-terminal-surface-retirements'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { Tab } from '../../shared/tab-types'
import {
  closeTerminalSurfaceInWorkspaceSession,
  resolveTerminalCloseTarget,
  type PaneCloseResolution
} from './terminal-surface-close'
import type {
  TerminalPaneCloseTarget,
  TerminalSurfaceCloseTarget
} from '../../shared/terminal-surface-close-target'
import { retireTerminalSurfacesFromSnapshot } from './mobile-session-terminal-retirement'
import type { PtyControllerInventory } from './runtime-pty-controller-contract'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'

export class OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs extends OrcaRuntimeWithPersistTerminalSurfaceRetirements {
  // Why: headless serve backs browser panes with offscreen WebContents that live
  // only in the BrowserManager, never in a renderer graph. Without surfacing them
  // as session tabs, a session.tabs snapshot (e.g. on terminal open) prunes the
  // paired browser tab and closing it fails with tab_not_found. Synthesize browser
  // session tabs from the live bridge so they are first-class alongside terminals.
  protected buildHeadlessMobileSessionBrowserTabs(
    worktreeId: string
  ): RuntimeMobileSessionBrowserTab[] {
    const serverTabs =
      this.offscreenBrowserBackend && this.agentBrowserBridge?.tabList
        ? this.agentBrowserBridge.tabList(worktreeId).tabs
        : []
    const publishedServerTabs = serverTabs.map((tab) => {
      const persistedProps = this.getPersistedUnifiedSessionTabProps(worktreeId, tab.browserPageId)
      return {
        type: 'browser' as const,
        // Why: an offscreen page has no separate workspace identity, so the page id
        // is its own workspace id (matches the server's browserWorkspaceId fallback).
        id: tab.browserPageId,
        title: tab.title || tab.url || 'Browser',
        browserWorkspaceId: tab.browserPageId,
        browserPageId: tab.browserPageId,
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
   * The one close transaction every explicit terminal close reaches: commit the membership
   * removal in the owning host's partition, then flush. Callers publish and kill afterwards.
   */
  protected closeTerminalSurface(
    worktreeId: string,
    target: TerminalSurfaceCloseTarget,
    options: { allowMissing?: boolean; force?: boolean } = {}
  ): string[] {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession || !this.store.flushOrThrow) {
      throw new Error('workspace_session_unavailable')
    }
    const result = closeTerminalSurfaceInWorkspaceSession(session, worktreeId, target, options)
    if (result.pinned) {
      throw new Error('terminal_tab_pinned')
    }
    if (!result.closed) {
      if (!options.allowMissing) {
        throw new Error('tab_not_found')
      }
      return []
    }
    this.setWorkspaceSessionForWorktree(worktreeId, result.session)
    try {
      this.store.flushOrThrow()
    } catch (error) {
      // Why no rollback: bookkeeping must not undo a user's close or skip its kill; the removal
      // stays in memory and the next flush writes it. Only host-started retirements roll back.
      console.error('[runtime] failed to flush terminal close:', error)
    }
    return result.ptyIdsToKill
  }

  /** The desktop renderer's close intent: the renderer already ran its pin guard and owns the kill. */
  closeTerminalSurfaceFromRenderer(worktreeId: string, target: TerminalSurfaceCloseTarget): void {
    this.closeTerminalSurface(worktreeId, target, { allowMissing: true, force: true })
  }

  /** Resolves a close main started against the copy of the tab's panes its layout owner holds. */
  protected resolveTerminalCloseTarget(
    worktreeId: string,
    target: TerminalSurfaceCloseTarget
  ): PaneCloseResolution | 'tab' {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    const graphLeafIds: string[] = []
    for (const leaf of this.leaves.values()) {
      if (leaf.tabId === target.tabId) {
        graphLeafIds.push(leaf.leafId)
      }
    }
    return resolveTerminalCloseTarget(target, {
      rendererListsTab: this.tabs.has(target.tabId),
      snapshotRows: (this.mobileSessionTabsByWorktree.get(worktreeId)?.tabs ?? []).filter(
        (row) => row.type === 'terminal' && row.parentTabId === target.tabId
      ),
      graphLeafIds,
      sessionLayout: session?.terminalLayoutsByTabId?.[target.tabId],
      sessionListsTab: Object.values(session?.tabsByWorktree ?? {}).some((tabs) =>
        tabs.some((tab) => tab.id === target.tabId)
      )
    })
  }

  /**
   * Commits a split pane's close that main started, then tells the desktop renderer to drop that
   * pane. Never touches the tab: a pane the session no longer lists commits nothing.
   */
  protected closeTerminalPane(worktreeId: string, target: TerminalPaneCloseTarget): void {
    try {
      this.closeTerminalSurface(worktreeId, target, { allowMissing: true })
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'workspace_session_unavailable') {
        throw error
      }
    }
    // Why: no exit may ever arrive to remove the pane. The notice is leaf-addressed, so it and the
    // renderer's exit handling are each a no-op after the other.
    this.retireClosedTerminalLeafFromMobileSnapshot(worktreeId, target.tabId, target.leafId)
    this.notifier?.closeTerminalPane?.(target.tabId, target.leafId)
  }

  /** A paired client's close of one pane: stops only that pane's process, commits only that pane. */
  protected closeMobileSessionTerminalPane(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): void {
    // Why best-effort, as for a tab: a failed kill must not keep a pane the user closed.
    const pty = this.findPtyForMobileTerminalTab(worktreeId, tab)
    if (pty) {
      this.ptyController?.kill(pty.ptyId)
    } else if (!this.tabs.has(tab.parentTabId) && tab.ptyId && parseAppSshPtyId(tab.ptyId)) {
      // Why: with no renderer to own the kill, a dormant SSH pane's durable id is its stop order.
      this.ptyController?.kill(tab.ptyId)
    }
    this.closeTerminalPane(worktreeId, { kind: 'pane', tabId: tab.parentTabId, leafId: tab.leafId })
  }

  private retireClosedTerminalLeafFromMobileSnapshot(
    worktreeId: string,
    tabId: string,
    leafId: string
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate) =>
        candidate.type === 'terminal' &&
        candidate.parentTabId === tabId &&
        candidate.leafId === leafId
    )
    // Why: a renderer that lists the tab republishes its own snapshot once it drops the pane.
    if (!snapshot || !tab || this.tabs.has(tabId)) {
      return
    }
    const proof = this.getMobileSessionTerminalRetirementProof(worktreeId, tab)
    const retired = retireTerminalSurfacesFromSnapshot({
      snapshot,
      ptyId: tab.ptyId ?? tab.parentLayout?.ptyIdsByLeafId?.[leafId] ?? '',
      exactSurfaces: [{ parentTabId: tabId, leafId }],
      exactOnly: true,
      ...(proof ? { retirementProofs: [proof] } : {})
    })
    if (retired) {
      this.storeMobileSessionSnapshot(worktreeId, retired.snapshot)
      this.notifyMobileSessionTabsChanged(worktreeId)
    }
  }

  protected persistHeadlessTerminalTabOrder(worktreeId: string, tabOrder: readonly string[]): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const orderIndexByTabId = new Map(tabOrder.map((tabId, index) => [tabId, index]))
    const tabs = session.tabsByWorktree[worktreeId] ?? []
    const reordered = [...tabs]
      .sort((a, b) => {
        const aIndex = orderIndexByTabId.get(a.id) ?? Number.MAX_SAFE_INTEGER
        const bIndex = orderIndexByTabId.get(b.id) ?? Number.MAX_SAFE_INTEGER
        return aIndex - bIndex || a.sortOrder - b.sortOrder || a.createdAt - b.createdAt
      })
      .map((tab, index) => ({
        ...tab,
        sortOrder: index
      }))
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [worktreeId]: reordered
      }
    })
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

  /**
   * Answers one client's session-tabs question: whether this runtime has taken back *that* client's
   * client-hosted pages yet, then that client's own tab selection.
   *
   * The hold is decided here and nowhere else, and it is set or cleared rather than only set, so a
   * frame built for one client can never carry another client's answer.
   */
  protected projectMobileSessionTabsForClient(
    result: RuntimeMobileSessionTabsResult,
    clientNavigationId?: string
  ): RuntimeMobileSessionTabsResult {
    return this.clientSessionTabSelections.project(
      this.withClientHostedPagesHold(result, clientNavigationId),
      clientNavigationId
    )
  }

  protected withClientHostedPagesHold(
    result: RuntimeMobileSessionTabsResult,
    clientNavigationId: string | undefined
  ): RuntimeMobileSessionTabsResult {
    return this.clientHostedPageReconciliation.holdFor(result, clientNavigationId, Date.now())
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
      // Why: reconnect exit bursts share one authoritative daemon inventory
      // instead of multiplying a full cross-generation list RPC per stale tab.
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
