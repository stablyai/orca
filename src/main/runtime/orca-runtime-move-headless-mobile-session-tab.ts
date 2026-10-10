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
} from '../../shared/workspace-layout/tab-group-moves'
import { randomUUID } from 'node:crypto'
import { withSelectedTabs } from './headless-tab-group-selection'
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
    this.persistHeadlessTabGroups(worktreeId, nextGroups, snapshot.tabGroupLayout)
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
    const groups = withSelectedTabs(snapshot.tabGroups ?? [], split.groups, hostTabId)
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeGroupId: split.newGroupId,
      tabGroups: groups,
      tabGroupLayout: split.layout
    }
    this.persistHeadlessTabGroups(worktreeId, groups, split.layout)
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
    const groups = withSelectedTabs(snapshot.tabGroups ?? [], moved.groups, hostTabId)
    const nextSnapshot: RuntimeMobileSessionTabsSnapshot = {
      ...snapshot,
      publicationEpoch: `headless:${Date.now().toString(36)}`,
      snapshotVersion: snapshot.snapshotVersion + 1,
      activeGroupId: move.targetGroupId,
      tabGroups: groups,
      tabGroupLayout: layout
    }
    this.persistHeadlessTabGroups(worktreeId, groups, layout)
    this.storeMobileSessionSnapshot(worktreeId, nextSnapshot)
    this.emitMobileSessionTabsSnapshot(nextSnapshot)
    return { moved: true }
  }

  // Persist the headless tab-GROUP layout so snapshot rebuilds keep the split; the tab bar and rows
  // follow the groups. Deleted by the switch (PR 6), when moves are layout commands.
  protected persistHeadlessTabGroups(
    worktreeId: string,
    groups: readonly RuntimeMobileSessionTabGroup[],
    layout: TabGroupLayoutNode | undefined
  ): void {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    if (!session || !this.store?.setWorkspaceSession) {
      return
    }
    const order = groups.flatMap((group) => group.tabOrder)
    const groupIdByTabId = new Map(
      groups.flatMap((group) => group.tabOrder.map((tabId) => [tabId, group.id] as const))
    )
    const position = (tabId: string): number => {
      const index = order.indexOf(tabId)
      return index === -1 ? order.length : index
    }
    const entries = session.unifiedTabs?.[worktreeId]
    const rows = session.tabsByWorktree[worktreeId]
    this.setWorkspaceSessionForWorktree(worktreeId, {
      ...session,
      ...(rows
        ? {
            tabsByWorktree: {
              ...session.tabsByWorktree,
              [worktreeId]: [...rows]
                .sort((a, b) => position(a.id) - position(b.id) || a.sortOrder - b.sortOrder)
                .map((row, sortOrder) => ({ ...row, sortOrder }))
            }
          }
        : {}),
      ...(entries
        ? {
            unifiedTabs: {
              ...session.unifiedTabs,
              [worktreeId]: entries.map((entry) => ({
                ...entry,
                groupId: groupIdByTabId.get(entry.id) ?? entry.groupId
              }))
            }
          }
        : {}),
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
      ...(layout ? { tabGroupLayouts: { ...session.tabGroupLayouts, [worktreeId]: layout } } : {})
    })
  }
}
