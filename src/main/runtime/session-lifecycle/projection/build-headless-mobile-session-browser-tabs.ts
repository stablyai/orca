import { OrcaRuntimeWithPersistTerminalSurfaceRetirements } from '../../session-tabs/terminal-surface-retirements'
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
import {
  captureTerminalCloseRequest,
  resolveTerminalCloseTarget,
  type PaneCloseResolution,
  type RendererTerminalClose,
  type TerminalSurfaceCloseOptions
} from '../../terminal-surface-close'
import type {
  TerminalPaneCloseTarget,
  TerminalSurfaceCloseTarget
} from '../../../../shared/terminal-surface-close-target'
import { retireTerminalSurfacesFromSnapshot } from '../../mobile-session-terminal-retirement'
import type { PtyControllerInventory } from '../../runtime-pty-controller-contract'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { captureAcknowledgedTerminalTabRetirement } from '../../workspace-session-terminal-tab-retirement-identity'
import { closeLeafOrTab } from '../../../persistence/terminal-topology/terminal-topology-commit'
import { markAgentLaunchesClosedByUser } from '../../../agent-launch/agent-launch-pane-attachment'

export abstract class OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs extends OrcaRuntimeWithPersistTerminalSurfaceRetirements {
  // Offscreen browser pages live outside renderer graphs; expose session rows or snapshots prune them and close fails with tab_not_found.
  protected buildHeadlessMobileSessionBrowserTabs(
    worktreeId: string
  ): RuntimeMobileSessionBrowserTab[] {
    // Saved tabs whose page starts on first use are listed as running ones are.
    const serverTabs =
      this.offscreenBrowserBackend && this.agentBrowserBridge?.tabList
        ? [
            ...this.agentBrowserBridge.tabList(worktreeId).tabs,
            ...this.serveBrowserTabs.listUnstarted(worktreeId)
          ]
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
    const originalHostId = this.getWorkspaceSessionHostIdForTab(worktreeId, tabId)
    return captureAcknowledgedTerminalTabRetirement(worktreeId, tabId, () => {
      const resolvedHostId = this.getWorkspaceSessionHostIdForTab(worktreeId, tabId)
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

  /** Commit explicit-close membership removal durably in the owning host partition before callers publish and kill. */
  protected async closeTerminalSurface(
    worktreeId: string,
    target: TerminalSurfaceCloseTarget,
    options: TerminalSurfaceCloseOptions = {}
  ): Promise<string[]> {
    const store = this.store
    if (!store?.getWorkspaceSession || !store.setWorkspaceSession || !store.runDurableMutation) {
      throw new Error('workspace_session_unavailable')
    }
    // Already-removed layout tabs have no newer owner to protect; refusing would strand them.
    const acknowledgeTabRetirement =
      target.kind === 'tab' && !options.closedByLayoutOwner
        ? this.captureTerminalTabRetirement(worktreeId, target.tabId)
        : null
    let ptyIdsToKill: string[] = []
    let refusal: Error | undefined
    const hostIds = () => this.getWorkspaceSessionHostIdsForTab(worktreeId, target.tabId)
    const fenced = acknowledgeTabRetirement !== null
    try {
      refusal = await store.runDurableMutation(
        closeLeafOrTab({
          worktreeId,
          target,
          options,
          ...captureTerminalCloseRequest(
            worktreeId,
            target,
            hostIds(),
            { getWorkspaceSession: (hostId) => store.getWorkspaceSession!(hostId) },
            fenced
          ),
          ownerMatches: () => !acknowledgeTabRetirement || acknowledgeTabRetirement().matches,
          hostIds,
          getSession: (hostId) => store.getWorkspaceSession!(hostId),
          setSession: (session, hostId) => store.setWorkspaceSession!(session, hostId),
          onClosed: (closedPtyIds) => {
            ptyIdsToKill = closedPtyIds
          }
        })
      )
    } catch (error) {
      console.error('[runtime] failed to persist terminal close:', error)
    }
    if (refusal) {
      throw refusal
    }
    return ptyIdsToKill
  }

  /** The desktop renderer's close intent: it already guarded, removed and killed; this only reports. */
  async closeTerminalSurfaceFromRenderer({ worktreeId, target, reason }: RendererTerminalClose) {
    const options = { allowMissing: true, force: true, closedByLayoutOwner: true, reason }
    await this.closeTerminalSurface(worktreeId, target, options)
  }

  /** Resolves a close main started against the copy of the tab's panes its layout owner holds. */
  protected resolveTerminalCloseTarget(
    worktreeId: string,
    target: TerminalSurfaceCloseTarget
  ): PaneCloseResolution | 'tab' {
    const graphLeafIds: string[] = []
    for (const leaf of this.leaves.values()) {
      if (leaf.tabId === target.tabId) {
        graphLeafIds.push(leaf.leafId)
      }
    }
    return resolveTerminalCloseTarget(target, {
      rendererListsTab: this.tabs.has(target.tabId),
      snapshotRows: (this.mobileSessionTabsByWorktree.get(worktreeId)?.tabs ?? []).filter(
        (row): row is RuntimeMobileSessionTerminalTab =>
          row.type === 'terminal' && row.parentTabId === target.tabId
      ),
      graphLeafIds,
      sessionLayout:
        this.getWorkspaceSessionForWorktree(worktreeId)?.terminalLayoutsByTabId?.[target.tabId]
    })
  }

  /** Commit only this pane's membership removal, then notify the renderer; absent panes commit nothing and the tab is untouched. */
  protected async closeTerminalPane(
    worktreeId: string,
    target: TerminalPaneCloseTarget
  ): Promise<void> {
    // An explicit close (a phone's, the CLI's): a launch still starting or delivering there stops.
    markAgentLaunchesClosedByUser(worktreeId, target)
    try {
      await this.closeTerminalSurface(worktreeId, target, { allowMissing: true })
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'workspace_session_unavailable') {
        throw error
      }
    }
    // Exit may never arrive; leaf-addressed retirement and renderer exit handling are mutually idempotent.
    this.retireClosedTerminalLeafFromMobileSnapshot(worktreeId, target.tabId, target.leafId)
    this.notifier?.closeTerminalPane?.(target.tabId, target.leafId)
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
    leafId: string
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionTerminalTab =>
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
