import type { Tab, TabGroup, TabGroupLayoutNode } from '../../shared/tab-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { TerminalWindowTransferSeed } from '../../shared/terminal-window-transfer'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  collectTabGroupLayoutGroupIds,
  removeTabGroupLayoutLeaf
} from '../runtime/headless-tab-group-split-layout'
import { reconcileTerminalTransferSelectors } from './terminal-window-transfer-session-selectors'

function withoutTab<T extends { id: string }>(items: readonly T[], tabId: string): T[] {
  return items.filter(({ id }) => id !== tabId)
}

function restoreAtPriorIndex<T extends { id: string }>(
  current: readonly T[],
  prior: readonly T[],
  item: T
): T[] {
  const kept = withoutTab(current, item.id)
  const index = prior.findIndex(({ id }) => id === item.id)
  kept.splice(Math.min(index === -1 ? kept.length : index, kept.length), 0, structuredClone(item))
  return kept
}

function findTerminalTab(
  state: WorkspaceSessionState,
  tabId: string
): { key: string; tab: TerminalTab } | null {
  for (const [key, tabs] of Object.entries(state.tabsByWorktree)) {
    const tab = tabs.find(({ id }) => id === tabId)
    if (tab) {
      return { key, tab }
    }
  }
  return null
}

function findUnifiedTab(
  state: WorkspaceSessionState,
  tabId: string
): { key: string; tab: Tab } | null {
  for (const [key, tabs] of Object.entries(state.unifiedTabs ?? {})) {
    const tab = tabs.find(({ id, entityId }) => id === tabId || entityId === tabId)
    if (tab) {
      return { key, tab }
    }
  }
  return null
}

function findTabGroup(
  state: WorkspaceSessionState,
  tabId: string
): { key: string; group: TabGroup } | null {
  for (const [key, groups] of Object.entries(state.tabGroups ?? {})) {
    const group = groups.find(({ tabOrder }) => tabOrder.includes(tabId))
    if (group) {
      return { key, group }
    }
  }
  return null
}

function restoreGroup(current: TabGroup | undefined, prior: TabGroup, tabId: string): TabGroup {
  if (!current) {
    return structuredClone(prior)
  }
  const tabOrder = restoreAtPriorIndex(
    current.tabOrder.map((id) => ({ id })),
    prior.tabOrder.map((id) => ({ id })),
    { id: tabId }
  ).map(({ id }) => id)
  const priorRecent = prior.recentTabIds ?? []
  const recentTabIds = priorRecent.includes(tabId)
    ? restoreAtPriorIndex(
        (current.recentTabIds ?? []).map((id) => ({ id })),
        priorRecent.map((id) => ({ id })),
        { id: tabId }
      ).map(({ id }) => id)
    : (current.recentTabIds ?? []).filter((id) => id !== tabId)
  const activeTabId =
    current.activeTabId === tabId || prior.activeTabId === tabId
      ? prior.activeTabId
      : current.activeTabId
  return { ...current, tabOrder, recentTabIds, activeTabId }
}

export function appendMissingGroup(
  current: TabGroupLayoutNode | undefined,
  groupId: string
): TabGroupLayoutNode {
  if (!current) {
    return { type: 'leaf', groupId }
  }
  if (collectTabGroupLayoutGroupIds(current).has(groupId)) {
    return current
  }
  return {
    type: 'split',
    direction: 'horizontal',
    first: current,
    second: { type: 'leaf', groupId }
  }
}

function restoreTabKeyedRecord(
  current: Record<string, string> | undefined,
  prior: Record<string, string> | undefined,
  tabId: string
): Record<string, string> | undefined {
  if (prior?.[tabId] === undefined) {
    if (!current) {
      return undefined
    }
    const next = { ...current }
    delete next[tabId]
    return next
  }
  return { ...current, [tabId]: prior[tabId] }
}

export function sessionHasTerminalTransferBacking(
  state: WorkspaceSessionState,
  tabId: string,
  ptyIds: readonly string[]
): boolean {
  const transferredPtyIds = new Set(ptyIds)
  return (
    Object.values(state.tabsByWorktree).some((tabs) =>
      tabs.some(({ id, ptyId }) => id === tabId || (ptyId && transferredPtyIds.has(ptyId)))
    ) ||
    Object.hasOwn(state.terminalLayoutsByTabId, tabId) ||
    Object.values(state.terminalLayoutsByTabId).some((layout) =>
      Object.values(layout.ptyIdsByLeafId ?? {}).some((id) => transferredPtyIds.has(id))
    ) ||
    Object.values(state.unifiedTabs ?? {}).some((tabs) =>
      tabs.some(({ id, entityId }) => id === tabId || entityId === tabId)
    ) ||
    Object.values(state.tabGroups ?? {}).some((groups) =>
      groups.some(({ tabOrder }) => tabOrder.includes(tabId))
    ) ||
    Object.hasOwn(state.remoteSessionIdsByTabId ?? {}, tabId)
  )
}

export function restoreTransferredTerminalSession(
  current: WorkspaceSessionState,
  prior: WorkspaceSessionState,
  seed: TerminalWindowTransferSeed
): WorkspaceSessionState {
  const next = structuredClone(current)
  const terminal = findTerminalTab(prior, seed.tabId)
  if (terminal) {
    next.tabsByWorktree[terminal.key] = restoreAtPriorIndex(
      next.tabsByWorktree[terminal.key] ?? [],
      prior.tabsByWorktree[terminal.key] ?? [],
      terminal.tab
    )
  }
  const layout = prior.terminalLayoutsByTabId[seed.tabId] ?? seed.layout
  next.terminalLayoutsByTabId[seed.tabId] = structuredClone(layout)

  const unified = findUnifiedTab(prior, seed.tabId)
  if (unified) {
    next.unifiedTabs ??= {}
    next.unifiedTabs[unified.key] = restoreAtPriorIndex(
      next.unifiedTabs[unified.key] ?? [],
      prior.unifiedTabs?.[unified.key] ?? [],
      unified.tab
    )
  }

  const group = findTabGroup(prior, seed.tabId)
  if (group) {
    next.tabGroups ??= {}
    const groups = next.tabGroups[group.key] ?? []
    const existing = groups.find(({ id }) => id === group.group.id)
    next.tabGroups[group.key] = existing
      ? groups.map((candidate) =>
          candidate.id === existing.id ? restoreGroup(existing, group.group, seed.tabId) : candidate
        )
      : [...groups, structuredClone(group.group)]
    next.tabGroupLayouts ??= {}
    next.tabGroupLayouts[group.key] = appendMissingGroup(
      next.tabGroupLayouts[group.key],
      group.group.id
    )
  }
  const remoteSessions = restoreTabKeyedRecord(
    next.remoteSessionIdsByTabId,
    prior.remoteSessionIdsByTabId,
    seed.tabId
  )
  if (remoteSessions) {
    next.remoteSessionIdsByTabId = remoteSessions
  } else {
    delete next.remoteSessionIdsByTabId
  }
  reconcileTerminalTransferSelectors(next, current, prior, seed, {})
  return next
}

export function removeTransferredTerminalSession(
  current: WorkspaceSessionState,
  prior: WorkspaceSessionState,
  seed: TerminalWindowTransferSeed
): WorkspaceSessionState {
  const next = structuredClone(current)
  for (const [key, tabs] of Object.entries(next.tabsByWorktree)) {
    next.tabsByWorktree[key] = withoutTab(tabs, seed.tabId)
  }
  const priorTerminal = findTerminalTab(prior, seed.tabId)
  if (priorTerminal) {
    next.tabsByWorktree[priorTerminal.key] = restoreAtPriorIndex(
      next.tabsByWorktree[priorTerminal.key] ?? [],
      prior.tabsByWorktree[priorTerminal.key] ?? [],
      priorTerminal.tab
    )
  }
  if (Object.hasOwn(prior.terminalLayoutsByTabId, seed.tabId)) {
    next.terminalLayoutsByTabId[seed.tabId] = structuredClone(
      prior.terminalLayoutsByTabId[seed.tabId]!
    )
  } else {
    delete next.terminalLayoutsByTabId[seed.tabId]
  }
  for (const [key, tabs] of Object.entries(next.unifiedTabs ?? {})) {
    next.unifiedTabs![key] = tabs.filter(
      ({ id, entityId }) => id !== seed.tabId && entityId !== seed.tabId
    )
  }
  const priorUnified = findUnifiedTab(prior, seed.tabId)
  if (priorUnified) {
    next.unifiedTabs ??= {}
    next.unifiedTabs[priorUnified.key] = restoreAtPriorIndex(
      next.unifiedTabs[priorUnified.key] ?? [],
      prior.unifiedTabs?.[priorUnified.key] ?? [],
      priorUnified.tab
    )
  }

  for (const [key, groups] of Object.entries(next.tabGroups ?? {})) {
    const removedGroupIds: string[] = []
    next.tabGroups![key] = groups.flatMap((group) => {
      const priorGroup = prior.tabGroups?.[key]?.find(({ id }) => id === group.id)
      const tabOrder = group.tabOrder.filter((id) => id !== seed.tabId)
      if (tabOrder.length === 0 && !priorGroup) {
        removedGroupIds.push(group.id)
        return []
      }
      return [
        {
          ...group,
          tabOrder,
          recentTabIds: group.recentTabIds?.filter((id) => id !== seed.tabId),
          activeTabId:
            group.activeTabId === seed.tabId
              ? (priorGroup?.activeTabId ?? tabOrder.at(-1) ?? null)
              : group.activeTabId
        }
      ]
    })
    for (const groupId of removedGroupIds) {
      const layout = next.tabGroupLayouts?.[key]
      if (layout) {
        const trimmed = removeTabGroupLayoutLeaf(layout, groupId)
        if (trimmed) {
          next.tabGroupLayouts![key] = trimmed
        } else {
          delete next.tabGroupLayouts![key]
        }
      }
    }
  }
  const priorGroup = findTabGroup(prior, seed.tabId)
  if (priorGroup) {
    next.tabGroups ??= {}
    const groups = next.tabGroups[priorGroup.key] ?? []
    const existing = groups.find(({ id }) => id === priorGroup.group.id)
    next.tabGroups[priorGroup.key] = existing
      ? groups.map((group) =>
          group.id === existing.id ? restoreGroup(existing, priorGroup.group, seed.tabId) : group
        )
      : [...groups, structuredClone(priorGroup.group)]
    next.tabGroupLayouts ??= {}
    next.tabGroupLayouts[priorGroup.key] = appendMissingGroup(
      next.tabGroupLayouts[priorGroup.key],
      priorGroup.group.id
    )
  }
  const remoteSessions = restoreTabKeyedRecord(
    next.remoteSessionIdsByTabId,
    prior.remoteSessionIdsByTabId,
    seed.tabId
  )
  if (remoteSessions) {
    next.remoteSessionIdsByTabId = remoteSessions
  } else {
    delete next.remoteSessionIdsByTabId
  }
  reconcileTerminalTransferSelectors(next, current, prior, seed, {})
  return next
}

export function removeTransferredTerminalSessionBacking(
  current: WorkspaceSessionState,
  seed: TerminalWindowTransferSeed
): WorkspaceSessionState {
  return removeTransferredTerminalSession(current, getDefaultWorkspaceSession(), seed)
}
import { getDefaultWorkspaceSession } from '../../shared/constants'
