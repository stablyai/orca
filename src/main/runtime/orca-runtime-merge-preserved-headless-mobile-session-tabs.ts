// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithSyncMobileSessionTabs } from './orca-runtime-sync-mobile-session-tabs'
import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import {
  getMobileSessionSnapshotTabIdentityKeys,
  mergeMobileSessionSnapshotTabs,
  mergeMobileSessionTabGroups
} from './mobile-session-tab-merge'
import { terminalLayoutContainsLeaf } from './headless-terminal-split-layout'
import { getHeadlessMobileSessionGroupId } from './mobile-session-layout-projection'

export class OrcaRuntimeWithMergePreservedHeadlessMobileSessionTabs extends OrcaRuntimeWithSyncMobileSessionTabs {
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
      tabGroups: this.mergeStructuredAgentSessionTabGroups(
        tabGroups,
        existing.tabGroups ?? [],
        normalizedPreservedTabs,
        activeTab?.id ?? null
      ),
      tabs
    }
  }

  protected mergeStructuredAgentSessionTabGroups(
    groups: readonly RuntimeMobileSessionTabGroup[],
    existingGroups: readonly RuntimeMobileSessionTabGroup[],
    preservedTabs: readonly RuntimeMobileSessionSnapshotTab[],
    activeTabId: string | null
  ): RuntimeMobileSessionTabGroup[] {
    const structuredTabs = preservedTabs.filter((tab) => tab.type === 'agent-session')
    if (structuredTabs.length === 0) {
      return [...groups]
    }
    const next = groups.map((group) => ({ ...group, tabOrder: [...group.tabOrder] }))
    for (const tab of structuredTabs) {
      const priorGroupId = existingGroups.find((group) => group.tabOrder.includes(tab.id))?.id
      const target = next.find((group) => group.id === priorGroupId) ?? next[0]
      if (target && !target.tabOrder.includes(tab.id)) {
        target.tabOrder.push(tab.id)
      }
      if (target && tab.id === activeTabId) {
        target.activeTabId = tab.id
      }
    }
    return next
  }

  protected releaseRuntimeSessionOwnershipForRendererRetiredTabs(
    incoming: RuntimeMobileSessionTabsSnapshot,
    existing: RuntimeMobileSessionTabsSnapshot | undefined
  ): void {
    if (!existing || this.isHeadlessBuiltMobileSessionPublicationBase(existing.publicationEpoch)) {
      return
    }
    const session = this.getWorkspaceSessionForWorktree(existing.worktree)
    const persistedTabs = session?.tabsByWorktree?.[existing.worktree]
    if (!session || !persistedTabs) {
      return
    }
    const persistedTabsById = new Map(persistedTabs.map((tab) => [tab.id, tab]))
    const incomingIds = new Set(
      incoming.tabs.flatMap((tab) => getMobileSessionSnapshotTabIdentityKeys(tab))
    )
    for (const tab of existing.tabs) {
      if (
        tab.type !== 'terminal' ||
        this.pendingMobileTerminalCreatesByKey.has(`${existing.worktree}::${tab.parentTabId}`) ||
        getMobileSessionSnapshotTabIdentityKeys(tab).some((id) => incomingIds.has(id))
      ) {
        continue
      }
      if (!this.hasLiveRuntimeSessionOwnedPtyBinding(existing.worktree, tab)) {
        continue
      }
      const persistedParent = persistedTabsById.get(tab.parentTabId)
      if (!persistedParent) {
        this.clearRuntimeSessionOwnershipForMobileTab(existing.worktree, existing, tab.parentTabId)
        continue
      }
      const layout = session.terminalLayoutsByTabId?.[tab.parentTabId]
      const boundPtyIds = [tab.ptyId, tab.parentLayout?.ptyIdsByLeafId?.[tab.leafId]].filter(
        (id): id is string => typeof id === 'string'
      )
      const persistedIds = new Set(
        [persistedParent.ptyId, ...Object.values(layout?.ptyIdsByLeafId ?? {})].filter(
          (id): id is string => typeof id === 'string'
        )
      )
      if (
        layout &&
        !layout.ptyIdsByLeafId?.[tab.leafId] &&
        !terminalLayoutContainsLeaf(layout.root, tab.leafId) &&
        !boundPtyIds.some((id) => persistedIds.has(id))
      ) {
        for (const ptyId of boundPtyIds) {
          const pty = this.ptysById.get(ptyId)
          if (pty?.worktreeId === existing.worktree && pty.tabId === tab.parentTabId) {
            pty.runtimeSessionOwned = false
            this.setPairedRendererSessionOwnership(ptyId, false)
          }
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
      tabGroups: mergeMobileSessionTabGroups(
        existing.worktree,
        existing.tabGroups ?? [],
        terminalTabs,
        activeTab?.type === 'terminal' ? activeTab : null
      ),
      tabs
    }
  }
}
