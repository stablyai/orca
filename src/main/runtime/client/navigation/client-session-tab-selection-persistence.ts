import { parsePersistedPersonTabs } from '../../../../shared/orca-profiles/persisted-person-tab'
import type {
  PersistedMobileClientTabSelection,
  PersistedMobileClientTabSelections
} from '../../../../shared/orca-profiles/persisted-state-types'

function normalizeClientSessionTabSelection(
  raw: unknown
): PersistedMobileClientTabSelection | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null
  }
  const candidate = raw as Partial<PersistedMobileClientTabSelection>
  const activeTabId = typeof candidate.activeTabId === 'string' ? candidate.activeTabId : null
  const activeGroupId = typeof candidate.activeGroupId === 'string' ? candidate.activeGroupId : null
  const activeTabIdByGroupId: Record<string, string> = {}
  if (
    typeof candidate.activeTabIdByGroupId === 'object' &&
    candidate.activeTabIdByGroupId &&
    !Array.isArray(candidate.activeTabIdByGroupId)
  ) {
    for (const [groupId, tabId] of Object.entries(candidate.activeTabIdByGroupId)) {
      if (typeof tabId === 'string') {
        activeTabIdByGroupId[groupId] = tabId
      }
    }
  }
  if (!activeTabId && !activeGroupId && Object.keys(activeTabIdByGroupId).length === 0) {
    return null
  }
  const recentTabIds = Array.isArray(candidate.recentTabIds)
    ? candidate.recentTabIds.filter((tabId): tabId is string => typeof tabId === 'string')
    : []
  const personTabs = Array.isArray(candidate.personTabs)
    ? candidate.personTabs.filter((sessionId): sessionId is string => typeof sessionId === 'string')
    : []
  const personTabList = parsePersistedPersonTabs(candidate.personTabList)
  return {
    activeTabId,
    activeGroupId,
    activeTabIdByGroupId,
    ...(recentTabIds.length > 0 ? { recentTabIds } : {}),
    ...(personTabs.length > 0 ? { personTabs } : {}),
    ...(personTabList.length > 0 ? { personTabList } : {})
  }
}

// Malformed disk/remote payloads must degrade to no selection without throwing.
export function normalizePersistedMobileClientTabSelections(
  raw: unknown
): PersistedMobileClientTabSelections {
  const normalized: PersistedMobileClientTabSelections = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return normalized
  }
  for (const [clientNavigationId, selectionsByWorktree] of Object.entries(raw)) {
    if (
      typeof selectionsByWorktree !== 'object' ||
      selectionsByWorktree === null ||
      Array.isArray(selectionsByWorktree)
    ) {
      continue
    }
    const entries: Record<string, PersistedMobileClientTabSelection> = {}
    for (const [worktreeId, selection] of Object.entries(selectionsByWorktree)) {
      const normalizedSelection = normalizeClientSessionTabSelection(selection)
      if (normalizedSelection) {
        entries[worktreeId] = normalizedSelection
      }
    }
    if (Object.keys(entries).length > 0) {
      normalized[clientNavigationId] = entries
    }
  }
  return normalized
}
