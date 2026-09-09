// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithPersistHeadlessSessionTabProps } from './orca-runtime-persist-headless-session-tab-props'
import type {
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabMove,
  RuntimeMobileSessionTabMoveResult,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import {
  buildHeadlessTabGroupMove,
  buildHeadlessTabGroupSplit
} from './headless-tab-group-split-layout'
import { randomUUID } from 'node:crypto'
import type { TabGroupLayoutNode } from '../../shared/tab-types'

export class OrcaRuntimeWithMoveHeadlessMobileSessionTab extends OrcaRuntimeWithPersistHeadlessSessionTabProps {
  protected moveHeadlessMobileSessionTab(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    move: RuntimeMobileSessionTabMove
  ): RuntimeMobileSessionTabMoveResult {
    if (move.kind === 'split') {
      return this.splitHeadlessMobileSessionTabGroup(worktreeId, snapshot, move)
    }
    if (move.kind === 'move-to-group') {
      return this.moveHeadlessMobileSessionTabToGroup(worktreeId, snapshot, move)
    }
    if (move.kind !== 'reorder') {
      throw new Error('renderer_unavailable')
    }
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const publicSnapshot = this.toMobileSessionTabsResult(snapshot)
    const targetGroup = publicSnapshot.tabGroups?.find((group) => group.id === move.targetGroupId)
    if (!targetGroup) {
      throw new Error('target_group_not_found')
    }
    const tabOrder = this.normalizeMobileSessionTabOrder(snapshot, targetGroup, move.tabOrder)
    const orderIndexByParentTabId = new Map(tabOrder.map((tabId, index) => [tabId, index]))
    const nextTabs = [...snapshot.tabs].sort((a, b) => {
      const aParent = a.type === 'terminal' ? a.parentTabId : a.id
      const bParent = b.type === 'terminal' ? b.parentTabId : b.id
      const aIndex = orderIndexByParentTabId.get(aParent) ?? Number.MAX_SAFE_INTEGER
      const bIndex = orderIndexByParentTabId.get(bParent) ?? Number.MAX_SAFE_INTEGER
      return aIndex - bIndex
    })
    const active = nextTabs.find((candidate) => candidate.isActive) ?? nextTabs[0] ?? null
    const reorderedTargetActiveTabId =
      active?.type === 'terminal' ? active.parentTabId : active ? active.id : (tabOrder[0] ?? null)
    // Why: reorder only changes ONE group's order. Preserve every other group so
    // a multi-group split isn't deleted by re-sorting tabs in one of its groups.
    const existingGroups = snapshot.tabGroups ?? []
    const nextGroups = existingGroups.some((group) => group.id === targetGroup.id)
      ? existingGroups.map((group) =>
          group.id === targetGroup.id
            ? { ...group, tabOrder, activeTabId: reorderedTargetActiveTabId }
            : group
        )
      : [{ ...targetGroup, tabOrder, activeTabId: reorderedTargetActiveTabId }]
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeTabId: active?.id ?? null,
      activeTabType: active?.type ?? null,
      tabGroups: nextGroups,
      tabs: nextTabs
    }
    this.persistHeadlessTerminalTabOrder(worktreeId, tabOrder)
    if (nextGroups.length > 1 && snapshot.tabGroupLayout) {
      this.persistHeadlessTabGroups(worktreeId, nextGroups, snapshot.tabGroupLayout)
    }
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    return { moved: true }
  }

  // Why: a drag-to-split-group used to be a client-only change the headless host
  // never modeled, so the next snapshot coalesced every tab back into one group.
  // Model + persist the multi-group layout so the split survives rebuilds.
  protected splitHeadlessMobileSessionTabGroup(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    move: Extract<RuntimeMobileSessionTabMove, { kind: 'split' }>
  ): RuntimeMobileSessionTabMoveResult {
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const split = buildHeadlessTabGroupSplit({
      groups: snapshot.tabGroups ?? [],
      layout: snapshot.tabGroupLayout,
      tabId: hostTabId,
      targetGroupId: move.targetGroupId,
      splitDirection: move.splitDirection,
      newGroupId: randomUUID()
    })
    if (!split) {
      // Renderer treats an unsplittable drop (e.g. last tab onto its own group)
      // as a no-op; mirror that instead of churning the snapshot.
      return { moved: true }
    }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeGroupId: split.newGroupId,
      tabGroups: split.groups,
      tabGroupLayout: split.layout
    }
    this.persistHeadlessTabGroups(worktreeId, split.groups, split.layout)
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    return { moved: true }
  }

  // Move a tab into an existing group on a headless serve (non-split drop).
  protected moveHeadlessMobileSessionTabToGroup(
    worktreeId: string,
    snapshot: RuntimeMobileSessionTabsSnapshot,
    move: Extract<RuntimeMobileSessionTabMove, { kind: 'move-to-group' }>
  ): RuntimeMobileSessionTabMoveResult {
    const hostTabId = this.resolveMobileSessionHostTabId(snapshot, move.tabId)
    if (!hostTabId) {
      throw new Error('tab_not_found')
    }
    const moved = buildHeadlessTabGroupMove({
      groups: snapshot.tabGroups ?? [],
      layout: snapshot.tabGroupLayout,
      tabId: hostTabId,
      targetGroupId: move.targetGroupId,
      index: move.index
    })
    if (!moved) {
      // Same-group / missing-target drop is a renderer no-op; mirror that.
      return { moved: true }
    }
    const layout = moved.layout ?? { type: 'leaf' as const, groupId: move.targetGroupId }
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeGroupId: move.targetGroupId,
      tabGroups: moved.groups,
      tabGroupLayout: layout
    }
    this.persistHeadlessTabGroups(worktreeId, moved.groups, layout)
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    return { moved: true }
  }

  // Persist the headless tab-GROUP layout so snapshot rebuilds keep the split.
  protected persistHeadlessTabGroups(
    worktreeId: string,
    groups: readonly RuntimeMobileSessionTabGroup[],
    layout: TabGroupLayoutNode
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      tabGroups: {
        ...session.tabGroups,
        [worktreeId]: groups.map((group) => ({
          id: group.id,
          worktreeId,
          activeTabId: group.activeTabId,
          tabOrder: [...group.tabOrder],
          ...(group.recentTabIds ? { recentTabIds: [...group.recentTabIds] } : {})
        }))
      },
      tabGroupLayouts: {
        ...session.tabGroupLayouts,
        [worktreeId]: layout
      }
    })
  }
}
