import type { OrcaRuntimeWithStoredMobileSnapshotHasStalePreservedTab as StoredMobileSnapshotHasStalePreservedTabMethods } from './mobile-session-publication-preservation'
import { OrcaRuntimeWithSyncMobileSessionTabs } from './mobile-session-reconciliation'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../../shared/runtime-types'
import {
  appendChatTabOrder,
  getMobileSessionSnapshotTabIdentityKeys,
  mergeMobileSessionSnapshotTabs,
  mergeMobileSessionTabGroups
} from '../mobile-session-tab-merge'
import { terminalLayoutContainsLeaf } from '../../../shared/workspace-session-pane-ownership'
import { getHeadlessMobileSessionGroupId } from '../mobile-session-layout-projection'

export abstract class OrcaRuntimeWithMergePreservedHeadlessMobileSessionTabs extends OrcaRuntimeWithSyncMobileSessionTabs {
  protected abstract collectPreservedHeadlessMobileSessionTabs(
    ...args: Parameters<
      StoredMobileSnapshotHasStalePreservedTabMethods['collectPreservedHeadlessMobileSessionTabs']
    >
  ): ReturnType<
    StoredMobileSnapshotHasStalePreservedTabMethods['collectPreservedHeadlessMobileSessionTabs']
  >

  protected mergePreservedHeadlessMobileSessionTabs(
    snapshot: RuntimeMobileSessionTabsSnapshot,
    existing: RuntimeMobileSessionTabsSnapshot | undefined
  ): RuntimeMobileSessionTabsSnapshot {
    if (!existing) {
      return snapshot
    }
    const preservedTabs = this.collectPreservedHeadlessMobileSessionTabs(existing, snapshot)
    if (preservedTabs.length === 0) {
      return snapshot
    }
    const preservedActiveTab = preservedTabs.find(
      (tab) => tab.id === existing.activeTabId && tab.isActive
    )
    const hasIncomingActiveTab = snapshot.tabs.some((tab) => tab.isActive)
    const normalizedPreservedTabs = preservedTabs.map((tab) =>
      hasIncomingActiveTab && !preservedActiveTab ? { ...tab, isActive: false } : tab
    )
    const normalizedIncomingTabs = preservedActiveTab
      ? snapshot.tabs.map((tab) => (tab.isActive ? { ...tab, isActive: false } : tab))
      : snapshot.tabs
    const tabs = mergeMobileSessionSnapshotTabs(normalizedIncomingTabs, normalizedPreservedTabs)
    if (tabs.length === snapshot.tabs.length) {
      return snapshot
    }
    const activeTab =
      preservedActiveTab ??
      normalizedIncomingTabs.find((tab) => tab.id === snapshot.activeTabId) ??
      tabs.find((tab) => tab.id === existing.activeTabId) ??
      tabs.find((tab) => tab.isActive) ??
      tabs[0] ??
      null
    const terminalTabs = tabs.filter(
      (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
    )
    const tabGroups = mergeMobileSessionTabGroups(
      snapshot.worktree,
      snapshot.tabGroups ?? existing.tabGroups ?? [],
      terminalTabs,
      activeTab?.type === 'terminal' ? activeTab : null
    )
    return {
      ...snapshot,
      publicationEpoch: this.getMergedMobileSessionPublicationEpoch(
        snapshot,
        normalizedPreservedTabs
      ),
      snapshotVersion: Math.max(snapshot.snapshotVersion, existing.snapshotVersion),
      activeGroupId: snapshot.activeGroupId ?? existing.activeGroupId,
      activeTabId: activeTab?.id ?? null,
      activeTabType: activeTab?.type ?? null,
      tabGroups: appendChatTabOrder(
        tabGroups,
        existing.tabGroups ?? [],
        normalizedPreservedTabs,
        activeTab?.id ?? null
      ),
      tabs
    }
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
    // Why no headless-built exemption: the first renderer publication after a restart lands on a
    // disk-hydrated base, and skipping it left a retired paired tab owned until the next sync (STA-4897).
    if (!existing) {
      return
    }
    for (const { tab, scope } of this.listRendererRetiredTerminalTabs(incoming, existing)) {
      if (!this.hasLiveRuntimeSessionOwnedPtyBinding(existing.worktree, tab)) {
        continue
      }
      if (scope === 'tab') {
        this.clearRuntimeSessionOwnershipForMobileTab(existing.worktree, existing, tab.parentTabId)
        continue
      }
      for (const ptyId of getMobileTerminalLeafPtyIds(tab)) {
        const pty = this.ptysById.get(ptyId)
        if (pty?.worktreeId === existing.worktree && pty.tabId === tab.parentTabId) {
          pty.runtimeSessionOwned = false
          this.setPairedRendererSessionOwnership(ptyId, false)
        }
      }
    }
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
    const terminalTabs = tabs.filter(
      (tab): tab is RuntimeMobileSessionTerminalTab => tab.type === 'terminal'
    )
    return {
      ...existing,
      publicationEpoch: this.getMergedMobileSessionPublicationEpoch(existing, tabs),
      // Why: mint a fresh version or clients' same-epoch gate drops the prune frame.
      snapshotVersion: existing.snapshotVersion + 1,
      activeGroupId: existing.activeGroupId ?? getHeadlessMobileSessionGroupId(existing.worktree),
      activeTabId: activeTab?.id ?? null,
      activeTabType: activeTab?.type ?? null,
      tabGroups: appendChatTabOrder(
        mergeMobileSessionTabGroups(
          existing.worktree,
          existing.tabGroups ?? [],
          terminalTabs,
          activeTab?.type === 'terminal' ? activeTab : null
        ),
        existing.tabGroups ?? [],
        tabs,
        activeTab?.id ?? null
      ),
      tabs
    }
  }
}

function getMobileTerminalLeafPtyIds(tab: RuntimeMobileSessionTerminalTab): string[] {
  return [tab.ptyId, tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId]].filter(
    (id): id is string => typeof id === 'string'
  )
}
