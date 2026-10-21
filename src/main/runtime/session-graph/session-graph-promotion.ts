import type { OrcaRuntimeWithHasTerminalsForWorktree as HasTerminalsForWorktreeMethods } from './session-graph-reload-lifecycle'
import type { OrcaRuntimeWithBindPtyIncarnationHandle as BindPtyIncarnationHandleMethods } from '../terminal/identity/terminal-handle-bindings'
import type { OrcaRuntimeWithResolveExitWaiters as ResolveExitWaitersMethods } from '../terminal/wait/terminal-wait-settlements'
import type { OrcaRuntimeWithCollectMobileVisibleGraphChangedWorktrees as CollectMobileVisibleGraphChangedWorktreesMethods } from '../session-tabs/session-tabs-inventory'
import type { OrcaRuntimeWithGetPtyRecordForPaneKey as GetPtyRecordForPaneKeyMethods } from '../orchestration/terminal-pane-mail-routing'
import type { OrcaRuntimeWithResolveWaiter as ResolveWaiterMethods } from '../orca-runtime-resolve-waiter'
import type { OrcaRuntimeWithMarkPtyLivenessUnverifiable as MarkPtyLivenessUnverifiableMethods } from '../terminal/layout/terminal-input-floor'
import type { OrcaRuntimeWithRecordPtyWorktree as RecordPtyWorktreeMethods } from '../terminal/identity/pty-worktree-record'
import type { RuntimeSessionTabsInventoryPublication as SessionTabsInventoryPublicationMethods } from '../session-tabs/session-tabs-inventory-publication'
import type { OrcaRuntimeWithRefreshFloatingWorkspacePtyLiveness as RefreshFloatingWorkspacePtyLivenessMethods } from '../terminal/lifecycle/floating-session-liveness'
import type { OrcaRuntimeWithTouchMobileSessionTabsForWorktree as TouchMobileSessionTabsForWorktreeMethods } from '../session-tabs/mobile-session-membership'
import type { OrcaRuntimeWithScheduleMobileSessionTabsChanged as ScheduleMobileSessionTabsChangedMethods } from '../session-tabs/session-tabs-change-publication'
import type { OrcaRuntimeWithSyncMobileSessionTabs as SyncMobileSessionTabsMethods } from '../session-tabs/mobile-session-reconciliation'
import { OrcaRuntimeWithNotifySshStateChanged } from '../workspaces/workspace-host-notifications'
import { HEADLESS_RUNTIME_WINDOW_ID } from '../../../shared/runtime-types'
import { ActiveGroupViewFacts } from '../view-facts/active-group-view-facts'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { RuntimePtyWorktreeRecord } from '../runtime-terminal-state-records'

export abstract class OrcaRuntimeWithAttachWindow extends OrcaRuntimeWithNotifySshStateChanged {
  /** The group each workspace shows, as the attached window last reported it (syncWindowGraph). */
  protected readonly activeGroupViewFacts = new ActiveGroupViewFacts()

  /** A paired desktop's `layout.reportView`: its reports count until its connection closes. */
  reportClientView(
    connectionId: string,
    activeGroupByWorkspace: Readonly<Record<string, string | null>>,
    refresh = false
  ): void {
    if (this.activeGroupViewFacts.mergeFromClient(connectionId, activeGroupByWorkspace, refresh)) {
      this.registerSubscriptionCleanup(
        `layout-view:${connectionId}`,
        () => this.activeGroupViewFacts.dropClient(connectionId),
        connectionId
      )
    }
  }

  protected editorOpenGroupFor(worktreeId: string): string | undefined {
    return this.activeGroupViewFacts.groupFor(worktreeId, () => {
      const hostId = this.tryGetWorkspaceSessionHostIdForWorktree(worktreeId)
      return hostId
        ? this.store?.getWorkspaceSession?.(hostId)?.activeGroupIdByWorktree?.[worktreeId]
        : undefined
    })
  }

  protected abstract beginGraphReload(
    ...args: Parameters<HasTerminalsForWorktreeMethods['beginGraphReload']>
  ): ReturnType<HasTerminalsForWorktreeMethods['beginGraphReload']>

  protected abstract adoptFirstPtyForLeafHandle(
    ...args: Parameters<BindPtyIncarnationHandleMethods['adoptFirstPtyForLeafHandle']>
  ): ReturnType<BindPtyIncarnationHandleMethods['adoptFirstPtyForLeafHandle']>

  protected abstract adoptPreAllocatedHandle(
    ...args: Parameters<BindPtyIncarnationHandleMethods['adoptPreAllocatedHandle']>
  ): ReturnType<BindPtyIncarnationHandleMethods['adoptPreAllocatedHandle']>

  protected abstract checkDeliverySettledAndArmRecheck(
    ...args: Parameters<ResolveExitWaitersMethods['checkDeliverySettledAndArmRecheck']>
  ): ReturnType<ResolveExitWaitersMethods['checkDeliverySettledAndArmRecheck']>

  protected abstract collectMobileVisibleGraphChangedWorktrees(
    ...args: Parameters<
      CollectMobileVisibleGraphChangedWorktreesMethods['collectMobileVisibleGraphChangedWorktrees']
    >
  ): ReturnType<
    CollectMobileVisibleGraphChangedWorktreesMethods['collectMobileVisibleGraphChangedWorktrees']
  >

  protected abstract deliverPendingMessagesForLeaf(
    ...args: Parameters<GetPtyRecordForPaneKeyMethods['deliverPendingMessagesForLeaf']>
  ): ReturnType<GetPtyRecordForPaneKeyMethods['deliverPendingMessagesForLeaf']>

  protected abstract getLeafKey(
    ...args: Parameters<ResolveWaiterMethods['getLeafKey']>
  ): ReturnType<ResolveWaiterMethods['getLeafKey']>

  abstract getPtyLivenessVerdict(
    ...args: Parameters<MarkPtyLivenessUnverifiableMethods['getPtyLivenessVerdict']>
  ): ReturnType<MarkPtyLivenessUnverifiableMethods['getPtyLivenessVerdict']>

  protected abstract invalidateLeafHandle(
    ...args: Parameters<BindPtyIncarnationHandleMethods['invalidateLeafHandle']>
  ): ReturnType<BindPtyIncarnationHandleMethods['invalidateLeafHandle']>

  protected abstract makeRuntimePaneKey(
    ...args: Parameters<RecordPtyWorktreeMethods['makeRuntimePaneKey']>
  ): ReturnType<RecordPtyWorktreeMethods['makeRuntimePaneKey']>

  abstract markGraphReady(
    ...args: Parameters<HasTerminalsForWorktreeMethods['markGraphReady']>
  ): ReturnType<HasTerminalsForWorktreeMethods['markGraphReady']>

  protected abstract markSessionTabsInventoryPublished(
    ...args: Parameters<SessionTabsInventoryPublicationMethods['markSessionTabsInventoryPublished']>
  ): ReturnType<SessionTabsInventoryPublicationMethods['markSessionTabsInventoryPublished']>

  protected abstract nextTitleObservationSequence(
    ...args: Parameters<GetPtyRecordForPaneKeyMethods['nextTitleObservationSequence']>
  ): ReturnType<GetPtyRecordForPaneKeyMethods['nextTitleObservationSequence']>

  protected abstract rebuildLeafPtyIndex(
    ...args: Parameters<RefreshFloatingWorkspacePtyLivenessMethods['rebuildLeafPtyIndex']>
  ): ReturnType<RefreshFloatingWorkspacePtyLivenessMethods['rebuildLeafPtyIndex']>

  protected abstract reconcileMobileSessionRetirementFences(
    ...args: Parameters<
      TouchMobileSessionTabsForWorktreeMethods['reconcileMobileSessionRetirementFences']
    >
  ): ReturnType<TouchMobileSessionTabsForWorktreeMethods['reconcileMobileSessionRetirementFences']>

  protected abstract reconcilePtyIncarnationHandles(
    ...args: Parameters<BindPtyIncarnationHandleMethods['reconcilePtyIncarnationHandles']>
  ): ReturnType<BindPtyIncarnationHandleMethods['reconcilePtyIncarnationHandles']>

  protected abstract recordPtyWorktree(
    ...args: Parameters<RecordPtyWorktreeMethods['recordPtyWorktree']>
  ): ReturnType<RecordPtyWorktreeMethods['recordPtyWorktree']>

  protected abstract scheduleMobileSessionTabsChanged(
    ...args: Parameters<ScheduleMobileSessionTabsChangedMethods['scheduleMobileSessionTabsChanged']>
  ): ReturnType<ScheduleMobileSessionTabsChangedMethods['scheduleMobileSessionTabsChanged']>

  protected abstract syncMobileSessionTabs(
    ...args: Parameters<SyncMobileSessionTabsMethods['syncMobileSessionTabs']>
  ): ReturnType<SyncMobileSessionTabsMethods['syncMobileSessionTabs']>

  attachWindow(windowId: number): void {
    if (this.authoritativeWindowId === HEADLESS_RUNTIME_WINDOW_ID) {
      if (
        this.pendingHeadlessPromotionWindowId !== null &&
        windowId !== this.pendingHeadlessPromotionWindowId
      ) {
        return
      }
      // Why: promotion is a renderer reload of the same graph owner, not a new
      // runtime; stale handles must transition before the real window publishes.
      this.persistWindowlessPtyBindingsForDesktopAttach()
      this.pendingHeadlessPromotionWindowId = windowId
      this.authoritativeWindowId = windowId
      this.beginGraphReload(windowId)
      return
    }
    if (this.authoritativeWindowId === null) {
      // Why: a promoted serve can close and later reopen its window while new
      // background PTYs keep arriving; every windowless gap needs this handoff.
      this.persistWindowlessPtyBindingsForDesktopAttach()
      this.authoritativeWindowId = windowId
    }
  }

  protected persistWindowlessPtyBindingsForDesktopAttach(): void {
    if (!this.store?.getWorkspaceSession || !this.store.setWorkspaceSession) {
      return
    }
    const partitions = new Map<
      ExecutionHostId,
      { session: WorkspaceSessionState; ptys: RuntimePtyWorktreeRecord[] }
    >()
    for (const pty of this.ptysById.values()) {
      if (!pty.connected || !pty.tabId) {
        continue
      }
      const hostId = this.getWorkspaceSessionHostIdForWorktree(pty.worktreeId)
      const session = this.store.getWorkspaceSession(hostId)
      const tab = session.tabsByWorktree[pty.worktreeId]?.find(
        (candidate) => candidate.id === pty.tabId
      )
      if (!tab) {
        continue
      }
      const layoutPtyIds = Object.values(
        session.terminalLayoutsByTabId[pty.tabId]?.ptyIdsByLeafId ?? {}
      )
      if (tab.ptyId !== pty.ptyId && !layoutPtyIds.includes(pty.ptyId)) {
        continue
      }
      const partition = partitions.get(hostId) ?? { session, ptys: [] }
      partition.ptys.push(pty)
      partitions.set(hostId, partition)
    }

    for (const [hostId, { session, ptys }] of partitions) {
      // Why: windowless SSH PTYs must be handed to the desktop through their SSH partition, never the local session.
      const activeWorktreeIdsOnShutdown = [
        ...new Set([
          ...(session.activeWorktreeIdsOnShutdown ?? []),
          ...ptys.map((pty) => pty.worktreeId)
        ])
      ]
      const activeConnectionIdsAtShutdown = [
        ...new Set([
          ...(session.activeConnectionIdsAtShutdown ?? []),
          ...ptys
            .map((pty) => pty.connectionId)
            .filter((connectionId): connectionId is string => connectionId !== null)
        ])
      ]
      const remoteSessionIdsByTabId = { ...session.remoteSessionIdsByTabId }
      for (const pty of ptys) {
        if (pty.connectionId && pty.tabId) {
          remoteSessionIdsByTabId[pty.tabId] = pty.ptyId
        }
      }

      this.store.setWorkspaceSession(
        {
          ...session,
          activeWorktreeIdsOnShutdown,
          ...(activeConnectionIdsAtShutdown.length > 0 ? { activeConnectionIdsAtShutdown } : {}),
          ...(Object.keys(remoteSessionIdsByTabId).length > 0 ? { remoteSessionIdsByTabId } : {})
        },
        hostId
      )
    }
  }
}
