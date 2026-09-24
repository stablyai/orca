// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithPersistTerminalSurfaceRetirements } from './orca-runtime-persist-terminal-surface-retirements'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import { getRuntimeBrowserPageRegistry } from './runtime-browser-page-registry'
import type { Tab } from '../../shared/tab-types'
import { closeTerminalTabInWorkspaceSession } from '../../shared/workspace-session-terminal-tab-close'
import { advanceTerminalTopologyRevision } from './workspace-session-terminal-membership-authority'
import type { PtyControllerInventory } from './runtime-pty-controller-contract'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../shared/constants'
import { captureAcknowledgedTerminalTabRetirement } from './workspace-session-terminal-tab-retirement-identity'
import { cloneWorkspaceSessionState } from '../persistence/restoring-sessions/session-owner-fields'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../persistence/restoring-sessions/workspace-session-write-rollback'

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

  protected captureTerminalTabRetirement(worktreeId: string, tabId: string) {
    const originalHostId = this.getWorkspaceSessionHostIdForWorktree(worktreeId)
    return captureAcknowledgedTerminalTabRetirement(worktreeId, tabId, () => {
      const resolvedHostId = this.getWorkspaceSessionHostIdForWorktree(worktreeId)
      const resolvedSession = this.store?.getWorkspaceSession?.(resolvedHostId)
      // Emptying the last tab may reroute the worktree to its catalog host.
      const hostId = resolvedSession?.tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId)
        ? resolvedHostId
        : originalHostId
      return {
        hostId,
        session: this.store?.getWorkspaceSession?.(hostId) ?? null,
        snapshot: this.mobileSessionTabsByWorktree.get(worktreeId),
        incarnationOf: (ptyId) => this.ptysById.get(ptyId)?.incarnationId
      }
    })
  }

  protected async commitHeadlessTerminalTabRetirement(
    worktreeId: string,
    parentTabId: string,
    options: { allowMissing?: boolean; force?: boolean } = {}
  ): Promise<string[]> {
    if (!this.store?.setWorkspaceSession || !this.store.runDurableMutation) {
      throw new Error('workspace_session_unavailable')
    }
    const acknowledgeRetirement = this.captureTerminalTabRetirement(worktreeId, parentTabId)
    return this.store.runDurableMutation(() => {
      if (!acknowledgeRetirement().matches) {
        throw new Error('terminal_pane_owner_changed')
      }
      const hostId = this.getWorkspaceSessionHostIdForWorktree(worktreeId)
      const currentSession = this.store.getWorkspaceSession(hostId)
      if (!currentSession) {
        throw new Error('workspace_session_unavailable')
      }
      const session = cloneWorkspaceSessionState(currentSession)
      const result = closeTerminalTabInWorkspaceSession(session, worktreeId, parentTabId, {
        force: options.force
      })
      if (result.pinned) {
        throw new Error('terminal_tab_pinned')
      }
      if (!result.closed && !options.allowMissing) {
        throw new Error('tab_not_found')
      }
      const persisted = result.closed
        ? advanceTerminalTopologyRevision(result.session, worktreeId)
        : session
      this.store.setWorkspaceSession(persisted, hostId)
      const staged = cloneWorkspaceSessionState(this.store.getWorkspaceSession(hostId))
      return {
        value: result.ptyIdsToKill,
        rollback: () => {
          const current = this.store.getWorkspaceSession(hostId)
          if (current) {
            const rolledBack = rollbackWorkspaceSessionAfterFailedAsyncWrite(
              session,
              staged,
              current
            )
            if (rolledBack !== current) {
              this.store.setWorkspaceSession(rolledBack, hostId)
            }
          }
        }
      }
    })
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
