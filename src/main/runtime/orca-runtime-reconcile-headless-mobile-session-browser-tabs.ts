// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithHydrateHeadlessMobileSessionTabsFromWorkspaceSession } from './orca-runtime-hydrate-headless-mobile-session-tabs-from-workspace-session'
import type {
  RuntimeMobileSessionBrowserTab,
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { headlessBrowserTabsUnchanged } from './mobile-session-browser-equality'
import { appendBrowserTabOrder } from './mobile-session-browser-group-projection'
import { parseAppSshPtyId, toComparableRelaySshPtyId } from '../../shared/ssh-pty-id'
import { toSshExecutionHostId } from '../../shared/execution-host'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { sshRemotePtyLeaseAllowsReattach } from '../../shared/ssh-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { RuntimeStore } from './runtime-store-contract'
import { SSH_PANE_RECOVERY_GRACE_MS } from './orca-runtime-core'
import { findTerminalTabIdForLeaf } from './workspace-session-terminal-membership-authority'

export class OrcaRuntimeWithReconcileHeadlessMobileSessionBrowserTabs extends OrcaRuntimeWithHydrateHeadlessMobileSessionTabsFromWorkspaceSession {
  // Why: keep an existing snapshot's browser tabs in sync with the live bridge
  // without rebuilding stable terminal state. Replaces browser entries with the
  // current live set and rewrites the browser portion of the primary group order.
  protected reconcileHeadlessMobileSessionBrowserTabs(
    worktreeId: string,
    existing: RuntimeMobileSessionTabsSnapshot
  ): void {
    const liveBrowserTabs = this.buildHeadlessMobileSessionBrowserTabs(worktreeId)
    const liveIds = liveBrowserTabs.map((tab) => tab.id)
    const existingBrowserTabs = existing.tabs.filter(
      (tab): tab is RuntimeMobileSessionBrowserTab => tab.type === 'browser'
    )
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
      publicationEpoch: `headless-hydrated:${Date.now().toString(36)}`,
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
    return tabs.some((tab) => {
      if (this.isServeOrSshOwnedPtyId(tab.ptyId)) {
        return true
      }
      const leafPtyIds = session.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId
      return (
        (leafPtyIds &&
          Object.values(leafPtyIds).some((ptyId) => this.isServeOrSshOwnedPtyId(ptyId))) ||
        // Why: expiry keeps pane coordinates so paired viewers can request a fresh shell.
        this.getRecentExpiredSshLease(worktreeId, tab.id, undefined) !== null
      )
    })
  }

  /**
   * The tab this leaf sits in NOW. Only the leaf half of a pane key is remint-stable: a lease
   * freezes its tabId at write time and `detachTerminalPaneToTab` moves a live pane, so the stored
   * tabId names the tab the pane LEFT. Matching a lease on it is wrong in both directions - it
   * accepts the coordinates the pane abandoned (recovering a pane that already moved on, which
   * binds one leaf in two tabs and orphans the PTY under the new one) and refuses the correct ones.
   * Same resolution `restoreReattachedPtyRuntime` already does for its own reattach fence.
   *
   * Both workspace partitions are read because SSH spawns bind panes into `ssh:<target>` while
   * reattach binds into `local`; consulting one would report "nowhere" for a pane the other holds.
   */
  protected findCurrentTerminalTabIdForLeaf(targetId: string, leafId: string): string | undefined {
    for (const leaf of this.leaves.values()) {
      if (leaf.leafId === leafId) {
        return leaf.tabId
      }
    }
    for (const pty of this.ptysById.values()) {
      const parsed = parsePaneKey(pty.paneKey ?? '')
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

  protected getRecentExpiredSshLease(
    worktreeId: string,
    tabId: string,
    leafId: string | undefined,
    ptyId?: string
  ): ReturnType<NonNullable<RuntimeStore['getSshRemotePtyLeases']>>[number] | null {
    const now = Date.now()
    return (
      this.store?.getSshRemotePtyLeases?.().find((lease) => {
        if (lease.state !== 'expired' || lease.worktreeId !== worktreeId) {
          return false
        }
        // Why eligibility belongs in the selection, not after it: a pane accumulates leases as it
        // re-leases under new relay ids, so `(worktreeId, tabId, leafId)` names several. A
        // superseded or relay-id-recycled predecessor is `expired` for a reason that already names
        // its successor, and the unqualified callers use this answer to decide a pane is still
        // recoverable — reporting one would offer paired viewers a recovery `recoverTerminalPane`
        // then refuses. Picking the first ELIGIBLE orphan also keeps a predecessor from shadowing
        // the successor that is genuinely reattachable.
        if (!sshRemotePtyLeaseAllowsReattach(lease)) {
          return false
        }
        // Leaf is the pane's identity; the frozen tabId is only trustworthy while nothing else can
        // say where the leaf actually lives.
        const currentTabId = lease.leafId
          ? this.findCurrentTerminalTabIdForLeaf(lease.targetId, lease.leafId)
          : undefined
        return (
          (currentTabId ?? lease.tabId) === tabId &&
          // Leases store RELAY form (`toStoredPtyId` -> `toRelaySshPtyId`); the runtime hands us
          // the APP form (`ssh:<target>@@pty-3`). A raw `===` therefore never held for an SSH
          // pane, which is what kept this reader's only ptyId-qualified caller inert.
          (ptyId === undefined ||
            lease.ptyId === toComparableRelaySshPtyId(lease.targetId, ptyId)) &&
          (leafId === undefined || lease.leafId === undefined || lease.leafId === leafId) &&
          lease.updatedAt <= now &&
          now - lease.updatedAt <= SSH_PANE_RECOVERY_GRACE_MS
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

  // Why: serve-* (local serve) and ssh:<conn>@@<relay> (SSH relay) ids are minted
  // ONLY for runtime-owned terminals and are preserved/re-hydrated, so tear them
  // down even if the renderer adopted a view (else they resurrect). The daemon
  // session form <worktreeId>@@<shortUuid> is deliberately NOT here: the daemon
  // mints it for ordinary renderer-owned local terminals too, so id shape can't
  // classify ownership for that form — renderer-graph membership does (below).
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
