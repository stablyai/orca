import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { TabGroup, TabGroupLayoutNode } from '../../shared/tab-types'
import { normalizeBrowserHistoryEntries } from '../../shared/workspace-session-browser-history'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  collectTabGroupLayoutGroupIds,
  removeTabGroupLayoutLeaf
} from '../runtime/headless-tab-group-split-layout'

const RECORD_MAP_FIELDS = [
  'activeFileIdByWorktree',
  'markdownFrontmatterVisible',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree',
  'activeTabIdByWorktree',
  'activeGroupIdByWorktree',
  'remoteSessionIdsByTabId',
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId',
  'sleepingAgentSessionsByPaneKey',
  'terminalPtyIncarnationsByPaneKey',
  'terminalSurfaceTombstonesByPaneKey'
] as const

function mergeItems<T>(lists: readonly (readonly T[])[], identity: (item: T) => string): T[] {
  const seen = new Set<string>()
  const merged: T[] = []
  for (const list of lists) {
    for (const item of list) {
      const key = identity(item)
      if (!seen.has(key)) {
        seen.add(key)
        merged.push(item)
      }
    }
  }
  return merged
}

function mergeArrayMap<T>(
  states: readonly WorkspaceSessionState[],
  read: (state: WorkspaceSessionState) => Record<string, T[]> | undefined,
  identity: (item: T) => string
): Record<string, T[]> {
  const keys = new Set(states.flatMap((state) => Object.keys(read(state) ?? {})))
  return Object.fromEntries(
    [...keys].sort().map((key) => [
      key,
      mergeItems(
        states.map((state) => read(state)?.[key] ?? []),
        identity
      )
    ])
  )
}

function mergeRecordField(
  states: readonly WorkspaceSessionState[],
  field: (typeof RECORD_MAP_FIELDS)[number]
): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined
  for (const state of states.toReversed()) {
    const value = state[field]
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged = { ...merged, ...(value as Record<string, unknown>) }
    }
  }
  return merged
}

function mergeStringArrays(
  values: readonly (readonly string[] | undefined)[]
): string[] | undefined {
  const merged = [...new Set(values.flatMap((value) => value ?? []))]
  return merged.length > 0 ? merged : undefined
}

function mergeTabGroups(states: readonly WorkspaceSessionState[]): Record<string, TabGroup[]> {
  const keys = new Set(states.flatMap((state) => Object.keys(state.tabGroups ?? {})))
  return Object.fromEntries(
    [...keys].map((key) => {
      const groups = new Map<string, TabGroup>()
      for (const state of states) {
        for (const group of state.tabGroups?.[key] ?? []) {
          const existing = groups.get(group.id)
          groups.set(
            group.id,
            existing
              ? {
                  ...existing,
                  activeTabId: existing.activeTabId ?? group.activeTabId,
                  tabOrder: [...new Set([...existing.tabOrder, ...group.tabOrder])],
                  recentTabIds: mergeStringArrays([existing.recentTabIds, group.recentTabIds])
                }
              : group
          )
        }
      }
      return [key, [...groups.values()]]
    })
  )
}

function mergeTabGroupLayouts(
  states: readonly WorkspaceSessionState[]
): Record<string, TabGroupLayoutNode> {
  const keys = new Set(states.flatMap((state) => Object.keys(state.tabGroupLayouts ?? {})))
  return Object.fromEntries(
    [...keys].sort().flatMap((key) => {
      let merged: TabGroupLayoutNode | null = null
      for (const state of states) {
        let addition: TabGroupLayoutNode | null = state.tabGroupLayouts?.[key] ?? null
        for (const groupId of collectTabGroupLayoutGroupIds(merged)) {
          addition = removeTabGroupLayoutLeaf(addition, groupId)
        }
        if (addition) {
          merged = merged
            ? { type: 'split', direction: 'horizontal', first: merged, second: addition }
            : addition
        }
      }
      return merged ? [[key, merged]] : []
    })
  )
}

export function mergeWindowSessions(
  states: readonly WorkspaceSessionState[]
): WorkspaceSessionState {
  if (states.length === 0) {
    return getDefaultWorkspaceSession()
  }
  const merged = structuredClone(states[0])
  merged.tabsByWorktree = mergeArrayMap(
    states,
    (state) => state.tabsByWorktree,
    (tab) => tab.id
  )
  merged.terminalLayoutsByTabId = {}
  for (const state of states) {
    for (const [tabId, layout] of Object.entries(state.terminalLayoutsByTabId)) {
      merged.terminalLayoutsByTabId[tabId] ??= layout
    }
  }

  const openFilesByWorktree = mergeArrayMap(
    states,
    (state) => state.openFilesByWorktree,
    (file) =>
      JSON.stringify([
        file.filePath,
        file.runtimeEnvironmentId ?? null,
        file.externalSshTargetId ?? null
      ])
  )
  if (Object.keys(openFilesByWorktree).length > 0) {
    merged.openFilesByWorktree = openFilesByWorktree
  }
  const browserTabsByWorktree = mergeArrayMap(
    states,
    (state) => state.browserTabsByWorktree,
    (tab) => tab.id
  )
  if (Object.keys(browserTabsByWorktree).length > 0) {
    merged.browserTabsByWorktree = browserTabsByWorktree
  }
  const browserPagesByWorkspace = mergeArrayMap(
    states,
    (state) => state.browserPagesByWorkspace,
    (page) => page.id
  )
  if (Object.keys(browserPagesByWorkspace).length > 0) {
    merged.browserPagesByWorkspace = browserPagesByWorkspace
  }
  merged.browserUrlHistory = normalizeBrowserHistoryEntries(
    states.flatMap((state) => state.browserUrlHistory ?? [])
  )

  const unifiedTabs = mergeArrayMap(
    states,
    (state) => state.unifiedTabs,
    (tab) => tab.id
  )
  if (Object.keys(unifiedTabs).length > 0) {
    merged.unifiedTabs = unifiedTabs
  }
  const tabGroups = mergeTabGroups(states)
  if (Object.keys(tabGroups).length > 0) {
    merged.tabGroups = tabGroups
  }
  const tabGroupLayouts = mergeTabGroupLayouts(states)
  if (Object.keys(tabGroupLayouts).length > 0) {
    merged.tabGroupLayouts = tabGroupLayouts
  }

  const asMutable = merged as unknown as Record<string, unknown>
  for (const field of RECORD_MAP_FIELDS) {
    const value = mergeRecordField(states, field)
    if (value) {
      asMutable[field] = value
    }
  }

  const topology: Record<string, number> = {}
  for (const state of states) {
    for (const [repoId, revision] of Object.entries(state.terminalTopologyRevisionByRepoId ?? {})) {
      topology[repoId] = Math.max(topology[repoId] ?? 0, revision)
    }
  }
  if (Object.keys(topology).length > 0) {
    merged.terminalTopologyRevisionByRepoId = topology
  }

  merged.activeWorktreeIdsOnShutdown = mergeStringArrays(
    states.map((state) => state.activeWorktreeIdsOnShutdown)
  )
  merged.activeConnectionIdsAtShutdown = mergeStringArrays(
    states.map((state) => state.activeConnectionIdsAtShutdown)
  )
  return structuredClone(merged)
}
