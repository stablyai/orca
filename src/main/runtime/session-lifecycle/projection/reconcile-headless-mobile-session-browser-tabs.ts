import type { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab as BrowserOwnership } from '../../session-tabs/mobile-session-publication-preservation'
import type { OrcaRuntimeWithPruneMobileSessionTabGroupLayout as MobileSessionProjection } from './prune-mobile-session-tab-group-layout'
import type { OrcaRuntimeWithCloseStructuredAgentSessionTab as StructuredSessionClose } from '../../session-tabs/structured-session-tab-close'
import type { OrcaRuntimeWithPerformMobileSessionPtyRecordsRefresh as MobileSessionRefresh } from './perform-mobile-session-pty-records-refresh'
import type { RuntimeWorkspaceCatalog as WorkspaceCatalog } from '../../workspaces/workspace-catalog'
import type { OrcaRuntimeWithResolveMobileSessionTerminalCommand as MobileTerminalStartup } from '../../terminal/launch/mobile-terminal-startup'
import type { OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal as OwnedMobileTerminalCreate } from '../../terminal/launch/mobile-terminal-owned-create'
import { OrcaRuntimeWithHydrateHeadlessMobileSessionTabsFromWorkspaceSession } from '../../session-tabs/mobile-session-hydration'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../../shared/runtime-types'
import { headlessBrowserTabsUnchanged } from '../../mobile-session-browser-equality'
import { appendBrowserTabOrder } from '../../mobile-session-browser-group-projection'
import { parseAppSshPtyId, toComparableRelaySshPtyId } from '../../../../shared/ssh-pty-id'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { sshRemotePtyLeaseAllowsReattach } from '../../../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { RuntimeStore } from '../../runtime-store-contract'
import { SSH_PANE_RECOVERY_GRACE_MS } from '../../orca-runtime-core'
import { findTerminalTabIdForLeaf } from '../../../persistence/terminal-topology/terminal-topology-membership'

export abstract class OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs extends OrcaRuntimeWithHydrateHeadlessMobileSessionTabsFromWorkspaceSession {
  protected abstract getAcceptedRendererIdentityKeysForMobileSessionSnapshot(
    ...args: Parameters<BrowserOwnership['getAcceptedRendererIdentityKeysForMobileSessionSnapshot']>
  ): ReturnType<BrowserOwnership['getAcceptedRendererIdentityKeysForMobileSessionSnapshot']>
  protected abstract isRendererOwnedMobileBrowserTab(
    ...args: Parameters<BrowserOwnership['isRendererOwnedMobileBrowserTab']>
  ): ReturnType<BrowserOwnership['isRendererOwnedMobileBrowserTab']>
  protected abstract findPtyForMobileTerminalTab(
    ...args: Parameters<MobileSessionProjection['findPtyForMobileTerminalTab']>
  ): ReturnType<MobileSessionProjection['findPtyForMobileTerminalTab']>
  protected abstract getMobileSessionTerminalRetirementProof(
    ...args: Parameters<StructuredSessionClose['getMobileSessionTerminalRetirementProof']>
  ): ReturnType<StructuredSessionClose['getMobileSessionTerminalRetirementProof']>
  protected abstract performMobileSessionPtyRecordsRefresh(
    ...args: Parameters<MobileSessionRefresh['performMobileSessionPtyRecordsRefresh']>
  ): ReturnType<MobileSessionRefresh['performMobileSessionPtyRecordsRefresh']>
  protected abstract listResolvedWorktrees(
    ...args: Parameters<WorkspaceCatalog['listResolvedWorktrees']>
  ): ReturnType<WorkspaceCatalog['listResolvedWorktrees']>
  protected abstract listKnownResolvedWorktreesForExplicitTarget(
    ...args: Parameters<WorkspaceCatalog['listKnownResolvedWorktreesForExplicitTarget']>
  ): ReturnType<WorkspaceCatalog['listKnownResolvedWorktreesForExplicitTarget']>
  protected abstract resolveMobileSessionTerminalCommand(
    ...args: Parameters<MobileTerminalStartup['resolveMobileSessionTerminalCommand']>
  ): ReturnType<MobileTerminalStartup['resolveMobileSessionTerminalCommand']>
  protected abstract createRuntimeOwnedMobileSessionTerminal(
    ...args: Parameters<OwnedMobileTerminalCreate['createRuntimeOwnedMobileSessionTerminal']>
  ): ReturnType<OwnedMobileTerminalCreate['createRuntimeOwnedMobileSessionTerminal']>

  // Refresh browser rows/order from the live bridge without rebuilding stable terminal state.
  protected reconcileHeadlessMobileSessionBrowserTabs(
    worktreeId: string,
    existing: RuntimeMobileSessionTabsSnapshot
  ): void {
    const existingBrowserTabs = existing.tabs.filter(
      (tab): tab is RuntimeMobileSessionBrowserTab => tab.type === 'browser'
    )
    if (this.offscreenBrowserBackend) {
      return this.reconcileOffscreenOwnedMobileSessionBrowserTabs(
        worktreeId,
        existing,
        existingBrowserTabs
      )
    }
    const publishedBrowserTabs = this.buildHeadlessMobileSessionBrowserTabs(worktreeId)
    // An attached renderer owns its browser rows; the client-page registry cannot retire them.
    const rendererBrowserTabs = this.getAvailableAuthoritativeWindow()
      ? existingBrowserTabs.filter((tab) => tab.placement?.kind !== 'client')
      : []
    // Deduplicate overlapping sources by id; newly built rows replace retained rows.
    const liveById = new Map(
      [...rendererBrowserTabs, ...publishedBrowserTabs].map((tab) => [tab.id, tab])
    )
    // Preserve snapshot order so index-based equality does not republish a pure reordering.
    const retainedInOrder = existingBrowserTabs.flatMap((tab) => {
      const live = liveById.get(tab.id)
      return live && liveById.delete(tab.id) ? [live] : []
    })
    const liveBrowserTabs = [...retainedInOrder, ...liveById.values()]
    const liveIds = liveBrowserTabs.map((tab) => tab.id)
    const existingBrowserIds = existingBrowserTabs.map((tab) => tab.id)
    if (headlessBrowserTabsUnchanged(liveBrowserTabs, existingBrowserTabs)) {
      return
    }
    const nonBrowserTabs = existing.tabs.filter((tab) => tab.type !== 'browser')
    const nextTabs: RuntimeMobileSessionSnapshotTab[] = [...nonBrowserTabs, ...liveBrowserTabs]
    const liveIdSet = new Set(liveIds)
    const tabGroups = appendBrowserTabOrder(
      (existing.tabGroups ?? []).map((group) => ({
        ...group,
        // Drop closed browser ids; appendBrowserTabOrder re-adds the live ones.
        tabOrder: group.tabOrder.filter(
          (id) => liveIdSet.has(id) || !existingBrowserIds.includes(id)
        )
      })),
      liveIds
    )
    const activeStillPresent = nextTabs.some((tab) => tab.id === existing.activeTabId)
    const active = activeStillPresent
      ? null
      : (nextTabs.find((tab) => tab.isActive) ?? nextTabs[0] ?? null)
    this.storeMobileSessionSnapshot(worktreeId, {
      ...existing,
      snapshotVersion: existing.snapshotVersion + 1,
      ...(activeStillPresent
        ? {}
        : { activeTabId: active?.id ?? null, activeTabType: active?.type ?? null }),
      tabGroups,
      tabs: nextTabs
    })
  }

  // Why: offscreen live pages replace only headless-owned rows; unmounted renderer tabs stay.
  protected reconcileOffscreenOwnedMobileSessionBrowserTabs(
    worktreeId: string,
    existing: RuntimeMobileSessionTabsSnapshot,
    existingBrowserTabs: RuntimeMobileSessionBrowserTab[]
  ): void {
    // An attached renderer's unaccepted epoch cannot acquire offscreen rows.
    if (
      this.getAvailableAuthoritativeWindow() &&
      !this.isHeadlessBuiltMobileSessionPublicationBase(existing.publicationEpoch) &&
      !this.getAcceptedRendererIdentityKeysForMobileSessionSnapshot(existing)
    ) {
      return
    }
    const existingHeadlessBrowserTabs = existingBrowserTabs.filter(
      (tab) => !this.isRendererOwnedMobileBrowserTab(existing, tab)
    )
    const builtById = new Map(
      this.buildHeadlessMobileSessionBrowserTabs(worktreeId).map((tab) => [tab.id, tab])
    )
    // Preserve snapshot order so index-based equality does not republish a pure reordering.
    const retainedInOrder = existingHeadlessBrowserTabs.flatMap((tab) => {
      const live = builtById.get(tab.id)
      return live && builtById.delete(tab.id) ? [live] : []
    })
    const liveBrowserTabs = [...retainedInOrder, ...builtById.values()]
    const existingHeadlessBrowserIds = new Set(
      existingHeadlessBrowserTabs.flatMap((tab) => [tab.id, tab.browserWorkspaceId])
    )
    if (headlessBrowserTabsUnchanged(liveBrowserTabs, existingHeadlessBrowserTabs)) {
      return
    }
    const liveIds = liveBrowserTabs.map((tab) => tab.id)
    const liveIdSet = new Set(liveIds)
    // Newly built rows replace a retained row with the same id.
    const retainedTabs = existing.tabs.filter(
      (tab) =>
        tab.type !== 'browser' ||
        (!existingHeadlessBrowserIds.has(tab.id) && !liveIdSet.has(tab.id))
    )
    const nextTabs: RuntimeMobileSessionSnapshotTab[] = [...retainedTabs, ...liveBrowserTabs]
    const tabGroups = appendBrowserTabOrder(
      (existing.tabGroups ?? []).map((group) => ({
        ...group,
        tabOrder: group.tabOrder.filter(
          (id) => liveIdSet.has(id) || !existingHeadlessBrowserIds.has(id)
        )
      })),
      liveIds
    )
    const activeStillPresent = nextTabs.some((tab) => tab.id === existing.activeTabId)
    const active = activeStillPresent
      ? null
      : (nextTabs.find((tab) => tab.isActive) ?? nextTabs[0] ?? null)
    this.storeMobileSessionSnapshot(worktreeId, {
      ...existing,
      snapshotVersion: existing.snapshotVersion + 1,
      ...(activeStillPresent
        ? {}
        : { activeTabId: active?.id ?? null, activeTabType: active?.type ?? null }),
      tabGroups,
      tabs: nextTabs
    })
  }

  protected isServeOwnedPtyId(ptyId: string | null | undefined): boolean {
    return typeof ptyId === 'string' && ptyId.startsWith('serve-')
  }

  protected isSshOwnedPtyId(ptyId: string | null | undefined): boolean {
    return typeof ptyId === 'string' && parseAppSshPtyId(ptyId) !== null
  }

  protected workspaceSessionHasRuntimeOwnedPtyCandidate(session: WorkspaceSessionState): boolean {
    return Object.entries(session.tabsByWorktree ?? {}).some(([worktreeId, tabs]) =>
      this.workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(session, worktreeId, tabs)
    )
  }

  protected workspaceSessionWorktreeHasRuntimeOwnedPtyCandidate(
    session: WorkspaceSessionState,
    worktreeId: string,
    tabs: WorkspaceSessionState['tabsByWorktree'][string]
  ): boolean {
    // Sweep leases lazily once per workspace for all tabs; serve/SSH-owned tabs may need no sweep.
    let recoverableTabIds: ReadonlySet<string | undefined> | undefined
    return tabs.some((tab) => {
      if (this.isServeOrSshOwnedPtyId(tab.ptyId)) {
        return true
      }
      const leafPtyIds = session.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId
      if (
        leafPtyIds &&
        Object.values(leafPtyIds).some((ptyId) => this.isServeOrSshOwnedPtyId(ptyId))
      ) {
        return true
      }
      // Why: expiry keeps pane coordinates so paired viewers can request a fresh shell.
      recoverableTabIds ??= this.collectRecentExpiredSshLeaseTabIds(worktreeId)
      return recoverableTabIds.has(tab.id)
    })
  }

  /** Resolve the leaf's current tab, not a lease's frozen pre-detach tabId, or recovery may duplicate/miss a moved pane. Read both host/local partitions for legacy SSH reattach records. */
  protected findCurrentTerminalTabIdForLeaf(targetId: string, leafId: string): string | undefined {
    for (const leaf of this.leaves.values()) {
      if (leaf.leafId === leafId) {
        return leaf.tabId
      }
    }
    for (const pty of this.ptysById.values()) {
      const parsed = parsePaneKey(this.paneOfPty(pty).paneKey ?? '')
      if (parsed?.leafId === leafId) {
        return parsed.tabId
      }
    }
    return (
      findTerminalTabIdForLeaf(this.store?.getWorkspaceSession?.(), leafId) ??
      findTerminalTabIdForLeaf(
        this.store?.getWorkspaceSession?.(toSshExecutionHostId(targetId)),
        leafId
      )
    )
  }

  /** Choose the first eligible orphan: superseded/recycled leases name a successor and must neither offer refused recovery nor shadow a reattachable lease. */
  private isRecentExpiredSshLeaseForWorktree(
    lease: ReturnType<NonNullable<RuntimeStore['getSshRemotePtyLeases']>>[number],
    worktreeId: string,
    now: number
  ): boolean {
    return (
      lease.state === 'expired' &&
      lease.worktreeId === worktreeId &&
      sshRemotePtyLeaseAllowsReattach(lease) &&
      lease.updatedAt <= now &&
      now - lease.updatedAt <= SSH_PANE_RECOVERY_GRACE_MS
    )
  }

  /**
   * Leaf is the pane's identity; the frozen tabId is only trustworthy while nothing else can say
   * where the leaf actually lives.
   */
  private resolveExpiredSshLeaseTabId(
    lease: ReturnType<NonNullable<RuntimeStore['getSshRemotePtyLeases']>>[number]
  ): string | undefined {
    const currentTabId = lease.leafId
      ? this.findCurrentTerminalTabIdForLeaf(lease.targetId, lease.leafId)
      : undefined
    return currentTabId ?? lease.tabId
  }

  /** The tabs a recent eligible expired lease still names, resolved in one sweep of the leases. */
  protected collectRecentExpiredSshLeaseTabIds(
    worktreeId: string
  ): ReadonlySet<string | undefined> {
    const now = Date.now()
    const tabIds = new Set<string | undefined>()
    for (const lease of this.store?.getSshRemotePtyLeases?.() ?? []) {
      if (this.isRecentExpiredSshLeaseForWorktree(lease, worktreeId, now)) {
        tabIds.add(this.resolveExpiredSshLeaseTabId(lease))
      }
    }
    return tabIds
  }

  protected getRecentExpiredSshLease(
    worktreeId: string,
    tabId: string,
    leafId: string | undefined,
    ptyId?: string
  ): ReturnType<NonNullable<RuntimeStore['getSshRemotePtyLeases']>>[number] | null {
    const now = Date.now()
    return (
      this.store?.getSshRemotePtyLeases?.().find((lease) => {
        if (!this.isRecentExpiredSshLeaseForWorktree(lease, worktreeId, now)) {
          return false
        }
        return (
          this.resolveExpiredSshLeaseTabId(lease) === tabId &&
          // Compare normalized ids: leases store relay form while callers supply ssh:<target>@@<pty> app form.
          (ptyId === undefined ||
            lease.ptyId === toComparableRelaySshPtyId(lease.targetId, ptyId)) &&
          (leafId === undefined || lease.leafId === undefined || lease.leafId === leafId)
        )
      }) ?? null
    )
  }

  protected hasRecentExpiredSshLeasePane(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    return this.getRecentExpiredSshLease(worktreeId, tab.parentTabId, tab.leafId) !== null
  }

  // Serve/SSH ids prove runtime ownership even with renderer views; ordinary daemon @@ ids also name renderer-owned terminals and require graph membership.
  protected isServeOrSshOwnedPtyId(ptyId: string | null | undefined): boolean {
    return this.isServeOwnedPtyId(ptyId) || this.isSshOwnedPtyId(ptyId)
  }

  protected hasServeOrSshOwnedBinding(tab: RuntimeMobileSessionTerminalTab): boolean {
    if (this.isServeOrSshOwnedPtyId(tab.ptyId)) {
      return true
    }
    return Object.values(tab.parentLayout?.ptyIdsByLeafId ?? {}).some((ptyId) =>
      this.isServeOrSshOwnedPtyId(ptyId)
    )
  }
}
