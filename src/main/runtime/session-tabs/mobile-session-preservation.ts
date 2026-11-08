import { isStructuredAgentSessionHostTabId } from '../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import {
  normalizeMobileSessionTabSelection,
  preserveLegacyPendingNavigation,
  resolveMobileSessionActiveTab
} from './mobile-session-tab-selection'
import type { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab as StoredMobileSnapshotHasStalePreservedTabMethods } from './mobile-session-publication-preservation'
import { OrcaRuntimeWithSyncMobileSessionTabs } from './mobile-session-reconciliation'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionTerminalTab } from '../../../shared/runtime-mobile-session-tab-contracts'
import {
  appendChatTabOrder,
  getMobileSessionSnapshotTabIdentityKeys,
  mergeMobileSessionSnapshotTabs,
  mergeMobileSessionTabGroups
} from '../session-lifecycle/projection/mobile-session-tab-merge'
import { terminalLayoutContainsLeaf } from '../../../shared/workspace-session/workspace-session-pane-ownership'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { terminalIsOfTab } from '../session-lifecycle/close/closed-tab-terminal'
import { getHeadlessMobileSessionGroupId } from '../terminal/surface/mobile-session-layout-projection'
import {
  appendBrowserTabOrder,
  collectBrowserGroupAssignment
} from '../session-lifecycle/projection/mobile-session-browser-group-projection'

export abstract class OrcaRuntimeWithMergePreservedHeadlessMobileSessionTabs extends OrcaRuntimeWithSyncMobileSessionTabs {
  protected abstract collectPreservedHeadlessMobileSessionTabs(
    ...args: Parameters<
      StoredMobileSnapshotHasStalePreservedTabMethods['collectPreservedHeadlessMobileSessionTabs']
    >
  ): ReturnType<
    StoredMobileSnapshotHasStalePreservedTabMethods['collectPreservedHeadlessMobileSessionTabs']
  >

  protected mergePreservedHeadlessMobileSessionTabs(
    incoming: RuntimeMobileSessionTabsSnapshot,
    existing: RuntimeMobileSessionTabsSnapshot | undefined
  ): RuntimeMobileSessionTabsSnapshot {
    const snapshot = preserveLegacyPendingNavigation(incoming, existing)
    if (!existing) {
      return normalizeMobileSessionTabSelection(snapshot)
    }
    const preservedTabs = this.collectPreservedHeadlessMobileSessionTabs(existing, snapshot)
    if (preservedTabs.length === 0) {
      return normalizeMobileSessionTabSelection(snapshot)
    }
    const tabs = mergeMobileSessionSnapshotTabs(snapshot.tabs, preservedTabs)
    const activeTab =
      snapshot.tabGroups !== undefined
        ? resolveMobileSessionActiveTab(snapshot, tabs)
        : (tabs.find((tab) => tab.id === snapshot.activeTabId) ??
          tabs.find((tab) => tab.isActive) ??
          tabs.find((tab) => tab.id === existing.activeTabId) ??
          tabs[0] ??
          null)
    const browserTabIds = preservedTabs.filter((tab) => tab.type === 'browser').map((tab) => tab.id)
    const tabGroups = appendChatTabOrder(
      appendBrowserTabOrder(
        mergeMobileSessionTabGroups(
          snapshot.worktree,
          snapshot.tabGroups ?? existing?.tabGroups ?? [],
          tabs,
          activeTab?.type === 'terminal' ? activeTab : null,
          existing.tabGroups
        ),
        browserTabIds,
        undefined,
        collectBrowserGroupAssignment(existing?.tabGroups, browserTabIds)
      ),
      existing?.tabGroups,
      preservedTabs
    )
    let activeGroupId =
      snapshot.tabGroups !== undefined
        ? snapshot.activeGroupId
        : (snapshot.activeGroupId ?? existing?.activeGroupId ?? null)
    if (snapshot.tabGroups === undefined && snapshot.activeTabId) {
      const selectedId =
        activeTab?.id === snapshot.activeTabId && activeTab.type === 'terminal'
          ? activeTab.parentTabId
          : snapshot.activeTabId
      const group =
        tabGroups.find((candidate) => candidate.tabOrder.includes(selectedId)) ??
        tabGroups.find((candidate) => candidate.id === activeGroupId)
      if (group) {
        group.activeTabId = selectedId
        if (isStructuredAgentSessionHostTabId(selectedId) && !group.tabOrder.includes(selectedId)) {
          group.tabOrder = [...group.tabOrder, selectedId]
        }
        activeGroupId = group.id
      }
    }
    return normalizeMobileSessionTabSelection({
      ...snapshot,
      publicationEpoch: this.getMergedMobileSessionPublicationEpoch(snapshot, preservedTabs),
      snapshotVersion: Math.max(snapshot.snapshotVersion, existing?.snapshotVersion ?? 0),
      activeGroupId,
      activeTabId: snapshot.activeTabId ?? activeTab?.id ?? null,
      activeTabType: snapshot.activeTabId ? snapshot.activeTabType : (activeTab?.type ?? null),
      tabGroups,
      tabs
    })
  }

  // Why: omitted from the renderer's publication AND from persistence = durably closed; a create in flight is not.
  protected listRendererRetiredTerminalTabs(
    incoming: RuntimeMobileSessionTabsSnapshot,
    existing: RuntimeMobileSessionTabsSnapshot
  ): { tab: RuntimeMobileSessionTerminalTab; scope: 'tab' | 'leaf' }[] {
    const session = this.getWorkspaceSessionForWorktree(existing.worktree)
    const persistedTabs = session?.tabsByWorktree?.[existing.worktree]
    if (!session || !persistedTabs) {
      return []
    }
    const persistedTabsById = new Map(persistedTabs.map((tab) => [tab.id, tab]))
    const incomingIds = new Set(
      incoming.tabs.flatMap((tab) => getMobileSessionSnapshotTabIdentityKeys(tab))
    )
    const retired: { tab: RuntimeMobileSessionTerminalTab; scope: 'tab' | 'leaf' }[] = []
    for (const tab of existing.tabs) {
      if (
        tab.type !== 'terminal' ||
        this.pendingMobileTerminalCreatesByKey.has(`${existing.worktree}::${tab.parentTabId}`) ||
        getMobileSessionSnapshotTabIdentityKeys(tab).some((id) => incomingIds.has(id))
      ) {
        continue
      }
      const persistedParent = persistedTabsById.get(tab.parentTabId)
      if (!persistedParent) {
        retired.push({ tab, scope: 'tab' })
        continue
      }
      const layout = session.terminalLayoutsByTabId?.[tab.parentTabId]
      const persistedIds = new Set(
        [persistedParent.ptyId, ...Object.values(layout?.ptyIdsByLeafId ?? {})].filter(
          (id): id is string => typeof id === 'string'
        )
      )
      if (
        layout &&
        !layout.ptyIdsByLeafId?.[tab.leafId] &&
        !terminalLayoutContainsLeaf(layout.root, tab.leafId) &&
        !getMobileTerminalLeafPtyIds(tab).some((id) => persistedIds.has(id))
      ) {
        retired.push({ tab, scope: 'leaf' })
      }
    }
    return retired
  }

  protected releaseRuntimeSessionOwnershipForRendererRetiredTabs(
    incoming: RuntimeMobileSessionTabsSnapshot,
    existing: RuntimeMobileSessionTabsSnapshot | undefined
  ): void {
    // First renderer frames after restart must prune disk-hydrated retired tabs too (STA-4897).
    if (!existing) {
      return
    }
    for (const { tab, scope } of this.listRendererRetiredTerminalTabs(incoming, existing)) {
      if (
        !this.hasLiveRuntimeSessionOwnedPtyBinding(existing.worktree, tab) &&
        !this.ownsTerminalMainClosed(existing.worktree, tab)
      ) {
        continue
      }
      if (scope === 'tab') {
        this.clearRuntimeSessionOwnershipForMobileTab(existing.worktree, existing, tab.parentTabId)
        continue
      }
      for (const ptyId of getMobileTerminalLeafPtyIds(tab)) {
        const pty = this.ptysById.get(ptyId)
        if (
          pty?.worktreeId === existing.worktree &&
          terminalIsOfTab(this.paneOfPty(pty).tabId, tab.parentTabId)
        ) {
          pty.runtimeSessionOwned = false
          this.setPairedRendererSessionOwnership(ptyId, false)
        }
      }
    }
  }

  /** Switch-on: the row's live, owned terminal that main's close left in no pane. */
  private ownsTerminalMainClosed(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): boolean {
    return (
      ORCA_LAYOUT_OWNER_IS_MAIN &&
      getMobileTerminalLeafPtyIds(tab).some((ptyId) => {
        const pty = this.ptysById.get(ptyId)
        return (
          pty?.worktreeId === worktreeId &&
          pty.connected &&
          pty.runtimeSessionOwned &&
          this.paneOfPty(pty).tabId === null
        )
      })
    )
  }

  protected buildPreservedHeadlessMobileSessionSnapshot(
    existing: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot | null {
    const tabs = this.collectPreservedHeadlessMobileSessionTabs(existing)
    if (tabs.length === 0) {
      return null
    }
    const activeTab =
      tabs.find((tab) => tab.id === existing.activeTabId) ??
      tabs.find((tab) => tab.isActive) ??
      tabs[0] ??
      null
    // Retained offscreen pages need headless ownership; terminal-only rebases would loosen terminal liveness checks.
    const rebaseToHeadless =
      !this.isHeadlessBuiltMobileSessionPublicationBase(existing.publicationEpoch) &&
      tabs.some((tab) => tab.type === 'browser' && tab.placement?.kind !== 'client')
    const publicationBase = rebaseToHeadless
      ? { ...existing, publicationEpoch: `headless-hydrated:${Date.now().toString(36)}` }
      : existing
    return normalizeMobileSessionTabSelection({
      ...existing,
      publicationEpoch: this.getMergedMobileSessionPublicationEpoch(publicationBase, tabs),
      // Bump version or clients discard same-epoch prune frames.
      snapshotVersion: existing.snapshotVersion + 1,
      activeGroupId: existing.activeGroupId ?? getHeadlessMobileSessionGroupId(existing.worktree),
      activeTabId: existing.activeTabId ?? activeTab?.id ?? null,
      activeTabType: activeTab?.type ?? null,
      tabGroups: appendChatTabOrder(
        mergeMobileSessionTabGroups(
          existing.worktree,
          existing.tabGroups ?? [],
          tabs,
          activeTab?.type === 'terminal' ? activeTab : null
        ),
        existing.tabGroups ?? [],
        tabs
      ),
      tabs
    })
  }
}

function getMobileTerminalLeafPtyIds(tab: RuntimeMobileSessionTerminalTab): string[] {
  return [tab.ptyId, tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId]].filter(
    (id): id is string => typeof id === 'string'
  )
}
