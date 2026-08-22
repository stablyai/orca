import type { Tab, TabGroup, TabGroupLayoutNode } from '../../shared/tab-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import type { TerminalWindowTransferSeed } from '../../shared/terminal-window-transfer'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  collectTabGroupLayoutGroupIds,
  removeTabGroupLayoutLeaf
} from '../runtime/headless-tab-group-split-layout'

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
  const recentTabIds = restoreAtPriorIndex(
    (current.recentTabIds ?? []).map((id) => ({ id })),
    (prior.recentTabIds ?? []).map((id) => ({ id })),
    { id: tabId }
  ).map(({ id }) => id)
  return { ...current, tabOrder, recentTabIds }
}

function appendMissingGroup(
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
    return current
  }
  return { ...current, [tabId]: prior[tabId] }
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
  next.remoteSessionIdsByTabId = restoreTabKeyedRecord(
    next.remoteSessionIdsByTabId,
    prior.remoteSessionIdsByTabId,
    seed.tabId
  )
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
  delete next.terminalLayoutsByTabId[seed.tabId]
  for (const [key, tabs] of Object.entries(next.unifiedTabs ?? {})) {
    next.unifiedTabs![key] = tabs.filter(
      ({ id, entityId }) => id !== seed.tabId && entityId !== seed.tabId
    )
  }

  const priorGroupIds = new Set(
    Object.values(prior.tabGroups ?? {}).flatMap((groups) => groups.map(({ id }) => id))
  )
  for (const [key, groups] of Object.entries(next.tabGroups ?? {})) {
    const removedGroupIds: string[] = []
    next.tabGroups![key] = groups.flatMap((group) => {
      const tabOrder = group.tabOrder.filter((id) => id !== seed.tabId)
      if (tabOrder.length === 0 && !priorGroupIds.has(group.id)) {
        removedGroupIds.push(group.id)
        return []
      }
      return [
        {
          ...group,
          tabOrder,
          recentTabIds: group.recentTabIds?.filter((id) => id !== seed.tabId),
          activeTabId:
            group.activeTabId === seed.tabId ? (tabOrder.at(-1) ?? null) : group.activeTabId
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
  if (next.remoteSessionIdsByTabId) {
    delete next.remoteSessionIdsByTabId[seed.tabId]
  }
  return next
}
