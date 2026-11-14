import type { MobileSessionTabSubscription } from '../construction/runtime-identity-state'
import { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab } from './mobile-session-publication-preservation'
import type { BrowserTabInfo } from '../../../shared/browser/runtime/runtime-browser-contracts'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionMarkdownTab
} from '../../../shared/runtime-mobile-session-tab-contracts'
import type {
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-session-contracts'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../shared/runtime-session-contracts'
import { getRuntimeBrowserPageRegistry } from '../browser/client-pages/runtime-browser-page-registry'
import { getMobileSessionTabOrderIds } from '../session-lifecycle/projection/mobile-session-tab-merge'
import { readCreatedWorkspaceLaunch } from '../../agent-launch/agent-launch-created-workspace'
import type { AgentSenderRevision } from '../../../shared/agent-sender-associations'
import { worktreeIdsEqual } from '../../../shared/worktree/id'

export abstract class OrcaRuntimeWithScheduleMobileSessionTabsChanged extends OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab {
  protected scheduleMobileSessionTabsChanged(worktreeId: string): void {
    this.pendingMobileSessionTabsChangeSequenceByWorktree.set(
      worktreeId,
      ++this.mobileSessionTabsChangeSequence
    )
    this.mobileSessionTabsNotifyCoalescer.schedule(worktreeId)
  }

  protected cancelScheduledMobileSessionTabsChanged(worktreeId: string): void {
    this.mobileSessionTabsNotifyCoalescer.cancel(worktreeId)
    this.pendingMobileSessionTabsChangeSequenceByWorktree.delete(worktreeId)
  }

  protected flushScheduledMobileSessionTabsChanged(worktreeId: string): void {
    const changeSequence = this.pendingMobileSessionTabsChangeSequenceByWorktree.get(worktreeId)
    if (changeSequence === undefined) {
      return
    }
    this.pendingMobileSessionTabsChangeSequenceByWorktree.delete(worktreeId)
    this.notifyMobileSessionTabsChangedNow(worktreeId, changeSequence)
  }

  protected notifyMobileSessionTabsChangedNow(worktreeId: string, changeSequence: number): void {
    if (this.mobileSessionTabListeners.size === 0) {
      return
    }
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    // Browser events are workspace-scoped; navigation/churn must not broadcast every workspace.
    this.createMobileSessionTabsDelivery()(this.toMobileSessionTabsResult(snapshot), changeSequence)
  }

  protected notifyMobileSessionTabSnapshots(): void {
    if (this.mobileSessionTabListeners.size === 0) {
      return
    }
    const deliver = this.createMobileSessionTabsDelivery()
    for (const snapshot of this.mobileSessionTabsByWorktree.values()) {
      deliver(this.toMobileSessionTabsResult(snapshot), ++this.mobileSessionTabsChangeSequence)
    }
  }

  /** One lazy sender pass belongs to this synchronous delivery, shared across scopes and listeners. */
  protected createMobileSessionTabsDelivery() {
    let senderScope: ReturnType<typeof this.agentProjections.senders.buildForFramePass> | undefined
    return (
      result: RuntimeMobileSessionTabsResult,
      changeSequence: number,
      clientNavigationId?: string,
      candidates?: readonly MobileSessionTabSubscription[],
      delivery?: 'reconciliation'
    ): void => {
      const { agentSenderAssociations: _senders, ...tabsOnly } = result
      // A frame for one client is already its projection; projecting again stacks the epoch suffix and revision, so the client fences it.
      const project = (frame: RuntimeMobileSessionTabsResult, id: string | undefined) =>
        clientNavigationId === undefined ? this.projectMobileSessionTabsForClient(frame, id) : frame
      let desktopFrame: RuntimeMobileSessionTabsResult | undefined
      try {
        for (const subscription of this.selectMobileSessionTabsListeners(
          result.worktree,
          clientNavigationId,
          candidates
        )) {
          if (!this.mobileSessionTabListeners.has(subscription)) {
            continue
          }
          let frame: RuntimeMobileSessionTabsResult = tabsOnly
          if (subscription.clientKind !== 'mobile') {
            if (!desktopFrame) {
              desktopFrame = result
              if (!result.agentSenderAssociations) {
                senderScope ??= this.agentProjections.senders.buildForFramePass()
                desktopFrame = { ...result, agentSenderAssociations: senderScope(result.worktree) }
              }
            }
            frame = desktopFrame
          }
          const supplied = project(frame, subscription.clientNavigationId)
          this.deliverMobileSessionTabsFrame(subscription, supplied, changeSequence, delivery)
        }
        const senders = desktopFrame?.agentSenderAssociations
        if (clientNavigationId === undefined && senders) {
          this.agentProjections.senders.acknowledgeFrame(result.worktree, senders)
        }
      } finally {
        if (senderScope) {
          this.releaseAgentSenderHistoryIfUnobserved()
        }
      }
    }
  }

  protected agentSenderGraphReply(base: AgentSenderRevision | undefined) {
    try {
      return this.agentProjections.senders.buildForGraph(base)
    } finally {
      this.releaseAgentSenderHistoryIfUnobserved()
    }
  }

  protected toMobileSessionTabsFrame(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    includeAgentSenders = true
  ): RuntimeMobileSessionTabsResult {
    const result = this.toMobileSessionTabsResult(snapshot)
    return includeAgentSenders ? this.withMobileSessionTabSenders(result) : result
  }

  protected withMobileSessionTabSenders(
    result: RuntimeMobileSessionTabsResult
  ): RuntimeMobileSessionTabsResult {
    try {
      return {
        ...result,
        agentSenderAssociations: this.agentProjections.senders.buildForFrame(result.worktree)
      }
    } finally {
      this.releaseAgentSenderHistoryIfUnobserved()
    }
  }

  protected toMobileSessionTabsFrames(
    snapshots: Iterable<RuntimeMobileSessionTabsSnapshot>,
    includeAgentSenders = true
  ): RuntimeMobileSessionTabsResult[] {
    let senderScope: ReturnType<typeof this.agentProjections.senders.buildForFramePass> | undefined
    try {
      return [...snapshots].map((snapshot) => {
        const result = this.toMobileSessionTabsResult(snapshot)
        if (!includeAgentSenders) {
          return result
        }
        senderScope ??= this.agentProjections.senders.buildForFramePass()
        return { ...result, agentSenderAssociations: senderScope(snapshot.worktree) }
      })
    } finally {
      if (senderScope) {
        this.releaseAgentSenderHistoryIfUnobserved()
      }
    }
  }

  protected getMobileSessionTabsForWorktree(
    worktreeId: string,
    clientNavigationId?: string,
    options?: { includeInitialSurfaceLaunch?: true; includeAgentSenders?: boolean }
  ): RuntimeMobileSessionTabsResult {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      const publishedEpoch = this.getAuthoritativeSessionTabsInventoryEpoch()
      if (publishedEpoch === null) {
        this.notifyEmptyWorktreeOnPublication(worktreeId)
      }
      const result = this.projectMobileSessionTabsForClient(
        this.emptyMobileSessionTabsResult(worktreeId, publishedEpoch, options?.includeAgentSenders),
        clientNavigationId
      )
      const launch = options?.includeInitialSurfaceLaunch
        ? readCreatedWorkspaceLaunch(this, worktreeId)
        : undefined
      return launch ? { ...result, initialSurfaceLaunch: launch } : result
    }
    const result = this.projectMobileSessionTabsForClient(
      this.toMobileSessionTabsFrame(snapshot, options?.includeAgentSenders),
      clientNavigationId
    )
    const launch = options?.includeInitialSurfaceLaunch
      ? readCreatedWorkspaceLaunch(this, worktreeId)
      : undefined
    return launch ? { ...result, initialSurfaceLaunch: launch } : result
  }

  // Only unpublished graphs mean ask later; published graphs without an entry are empty, allowing the first terminal create.
  protected emptyMobileSessionTabsResult(
    worktreeId: string,
    publishedEpoch: number | null,
    includeAgentSenders = true
  ): RuntimeMobileSessionTabsResult {
    const result: RuntimeMobileSessionTabsResult = {
      worktree: worktreeId,
      publicationEpoch:
        publishedEpoch === null
          ? UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH
          : `empty:${publishedEpoch}`,
      snapshotVersion: 0,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    }
    return includeAgentSenders ? this.withMobileSessionTabSenders(result) : result
  }

  // Empty workspaces get no normal publication notice; explicitly settle clients previously told ask later.
  protected notifyEmptyWorktreeOnPublication(worktreeId: string): void {
    if (this.worktreesAwaitingSessionTabsPublication.has(worktreeId)) {
      return
    }
    this.worktreesAwaitingSessionTabsPublication.add(worktreeId)
    const onPublished = (): void => {
      this.sessionTabsInventoryWaiters.delete(onPublished)
      this.worktreesAwaitingSessionTabsPublication.delete(worktreeId)
      const publishedEpoch = this.getAuthoritativeSessionTabsInventoryEpoch()
      if (
        publishedEpoch === null ||
        [...this.mobileSessionTabsByWorktree.keys()].some((id) => worktreeIdsEqual(id, worktreeId))
      ) {
        return
      }
      const result = this.emptyMobileSessionTabsResult(worktreeId, publishedEpoch, false)
      this.createMobileSessionTabsDelivery()(result, ++this.mobileSessionTabsChangeSequence)
    }
    this.sessionTabsInventoryWaiters.add(onPublished)
  }

  protected emitMobileSessionTabsSnapshotToClient(
    projected: RuntimeMobileSessionTabsResult,
    clientNavigationId: string,
    follow = false,
    deliver = this.createMobileSessionTabsDelivery()
  ): void {
    deliver(
      follow ? { ...projected, navigationIntent: 'follow' } : projected,
      ++this.mobileSessionTabsChangeSequence,
      clientNavigationId
    )
  }

  protected async resolveMobileMarkdownWorktreeId(
    worktreeSelector: string,
    tabId: string
  ): Promise<string> {
    const worktreeId =
      this.getExplicitSessionWorktreeIdSelector(worktreeSelector) ??
      (await this.resolveWorkspaceSelector(worktreeSelector)).id
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate): candidate is RuntimeMobileSessionMarkdownTab =>
        candidate.type === 'markdown' && candidate.id === tabId
    )
    if (!tab) {
      throw new Error('tab_not_found')
    }
    return worktreeId
  }

  /** Every browser tab clients see: running pages and saved tabs whose page starts on first use. */
  protected getListedBrowserTabsByPageId(worktreeId: string): Map<string, BrowserTabInfo> {
    const liveTabs = this.agentBrowserBridge?.tabList?.(worktreeId).tabs ?? []
    const byPageId = new Map(liveTabs.map((tab) => [tab.browserPageId, tab]))
    for (const [index, page] of getRuntimeBrowserPageRegistry(this)
      .listPages(worktreeId)
      .entries()) {
      byPageId.set(page.browserPageId, {
        browserPageId: page.browserPageId,
        index: liveTabs.length + index,
        url: page.url,
        title: page.title,
        active: page.active,
        worktreeId,
        profileId: page.browserProfileId
      })
    }
    for (const tab of this.serveBrowserTabs.listUnstarted(worktreeId)) {
      byPageId.set(tab.browserPageId, tab)
    }
    return byPageId
  }

  protected collectReturnedSessionTabIds(
    tabs: readonly RuntimeMobileSessionClientTab[]
  ): Set<string> {
    return new Set(tabs.flatMap(getMobileSessionTabOrderIds))
  }

  protected sanitizeMobileSessionTabGroups(
    groups: readonly RuntimeMobileSessionTabGroup[] | undefined,
    returnedTabs: readonly RuntimeMobileSessionClientTab[]
  ): RuntimeMobileSessionTabGroup[] | undefined {
    if (!groups || groups.length === 0) {
      return undefined
    }
    const returnedIds = this.collectReturnedSessionTabIds(returnedTabs)
    const sanitized = groups
      .map((group): RuntimeMobileSessionTabGroup | null => {
        const tabOrder = group.tabOrder.filter((tabId) => returnedIds.has(tabId))
        if (tabOrder.length === 0) {
          return null
        }
        const recentTabIds = group.recentTabIds?.filter((tabId) => tabOrder.includes(tabId))
        return {
          id: group.id,
          activeTabId:
            group.activeTabId && tabOrder.includes(group.activeTabId) ? group.activeTabId : null,
          tabOrder,
          ...(recentTabIds && recentTabIds.length > 0 ? { recentTabIds } : {})
        }
      })
      .filter((group): group is RuntimeMobileSessionTabGroup => group !== null)
    return sanitized.length > 0 ? sanitized : undefined
  }
}
