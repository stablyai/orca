import type {
  Tab,
  TabGroup,
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  WorkspaceSessionState
} from '../../shared/types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree-id'
import { pruneTabGroupLayoutAfterRetirement } from './mobile-session-terminal-retirement'

function collectLeafIds(node: TerminalPaneLayoutNode | null, ids: Set<string>): void {
  if (!node) {
    return
  }
  if (node.type === 'leaf') {
    ids.add(node.leafId)
    return
  }
  collectLeafIds(node.first, ids)
  collectLeafIds(node.second, ids)
}

function layoutHasSameMembership(
  candidate: TerminalLayoutSnapshot,
  current: TerminalLayoutSnapshot
): boolean {
  const candidateIds = new Set<string>()
  const currentIds = new Set<string>()
  collectLeafIds(candidate.root, candidateIds)
  collectLeafIds(current.root, currentIds)
  return (
    candidateIds.size === currentIds.size &&
    [...candidateIds].every((leafId) => currentIds.has(leafId))
  )
}

function rebaseLayout(
  candidate: TerminalLayoutSnapshot | undefined,
  current: TerminalLayoutSnapshot | undefined
): TerminalLayoutSnapshot | undefined {
  if (!current) {
    return undefined
  }
  if (!candidate || !layoutHasSameMembership(candidate, current)) {
    return current
  }
  return {
    ...candidate,
    // Why: renderer layout metadata may move, but only host-persisted live bindings may name PTYs.
    ptyIdsByLeafId: {
      ...candidate.ptyIdsByLeafId,
      ...current.ptyIdsByLeafId
    }
  }
}

function terminalUnifiedTabMatches(tab: Tab, terminalTabIds: ReadonlySet<string>): boolean {
  return (
    tab.contentType === 'terminal' &&
    (terminalTabIds.has(tab.id) || terminalTabIds.has(tab.entityId))
  )
}

function rebaseUnifiedTabs(
  candidate: readonly Tab[],
  current: readonly Tab[],
  terminalTabIds: ReadonlySet<string>
): Tab[] {
  const result = candidate.filter(
    (tab) => tab.contentType !== 'terminal' || terminalUnifiedTabMatches(tab, terminalTabIds)
  )
  const representedTerminalIds = new Set(
    result.filter((tab) => tab.contentType === 'terminal').flatMap((tab) => [tab.id, tab.entityId])
  )
  for (const tab of current) {
    if (
      terminalUnifiedTabMatches(tab, terminalTabIds) &&
      !representedTerminalIds.has(tab.id) &&
      !representedTerminalIds.has(tab.entityId)
    ) {
      result.push(tab)
    }
  }
  return result
}

function rebaseTabGroups(
  groups: readonly TabGroup[],
  validTabIds: ReadonlySet<string>
): TabGroup[] {
  return groups.flatMap((group) => {
    const tabOrder = group.tabOrder.filter((tabId) => validTabIds.has(tabId))
    if (tabOrder.length === 0) {
      return []
    }
    const activeTabId =
      group.activeTabId && tabOrder.includes(group.activeTabId)
        ? group.activeTabId
        : (tabOrder[0] ?? null)
    const recentTabIds = group.recentTabIds?.filter((tabId) => tabOrder.includes(tabId))
    return [
      {
        ...group,
        tabOrder,
        activeTabId,
        ...(recentTabIds && recentTabIds.length > 0 ? { recentTabIds } : {})
      }
    ]
  })
}

function rebaseIncarnationBindings(
  session: WorkspaceSessionState,
  prior: WorkspaceSessionState
): Record<string, string> | undefined {
  const terminalTabIds = new Set(
    Object.values(session.tabsByWorktree).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
  const allowedPaneKeys = new Set<string>()
  for (const tabId of terminalTabIds) {
    const layout = session.terminalLayoutsByTabId[tabId]
    if (!layout) {
      continue
    }
    const leafIds = new Set<string>()
    collectLeafIds(layout.root, leafIds)
    for (const leafId of leafIds) {
      allowedPaneKeys.add(`${tabId}:${leafId}`)
    }
  }
  const merged = {
    ...session.terminalPtyIncarnationsByPaneKey,
    ...prior.terminalPtyIncarnationsByPaneKey
  }
  const retained = Object.fromEntries(
    Object.entries(merged).filter(([paneKey]) => {
      const separator = paneKey.lastIndexOf(':')
      if (separator < 1) {
        return false
      }
      const tabId = paneKey.slice(0, separator)
      return session.terminalLayoutsByTabId[tabId]
        ? allowedPaneKeys.has(paneKey)
        : terminalTabIds.has(tabId)
    })
  )
  return Object.keys(retained).length > 0 ? retained : undefined
}

export function advanceTerminalTopologyRevision(
  session: WorkspaceSessionState,
  worktreeId: string
): WorkspaceSessionState {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return {
    ...session,
    terminalTopologyRevisionByRepoId: {
      ...session.terminalTopologyRevisionByRepoId,
      [repoId]: (session.terminalTopologyRevisionByRepoId?.[repoId] ?? 0) + 1
    }
  }
}

export function hasHostAuthoritativeTerminalMembership(
  session: WorkspaceSessionState | undefined,
  worktreeId: string
): boolean {
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  return (
    (session?.terminalTopologyRevisionByRepoId?.[repoId] ?? 0) > 0 ||
    Object.values(session?.terminalSurfaceTombstonesByPaneKey ?? {}).some(
      (tombstone) => tombstone.worktreeId === worktreeId
    )
  )
}

export function rebaseWorkspaceSessionTerminalMembership(
  incoming: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined
): WorkspaceSessionState {
  if (!prior?.terminalTopologyRevisionByRepoId) {
    return incoming
  }
  const terminalTopologyRevisionByRepoId = { ...incoming.terminalTopologyRevisionByRepoId }
  for (const [repoId, revision] of Object.entries(prior.terminalTopologyRevisionByRepoId)) {
    terminalTopologyRevisionByRepoId[repoId] = Math.max(
      revision,
      terminalTopologyRevisionByRepoId[repoId] ?? 0
    )
  }
  const tabsByWorktree = { ...incoming.tabsByWorktree }
  const terminalLayoutsByTabId = { ...incoming.terminalLayoutsByTabId }
  const unifiedTabs = { ...incoming.unifiedTabs }
  const tabGroups = { ...incoming.tabGroups }
  const tabGroupLayouts = { ...incoming.tabGroupLayouts }
  const activeTabIdByWorktree = { ...incoming.activeTabIdByWorktree }
  let includeUnifiedTabs = incoming.unifiedTabs !== undefined
  let includeTabGroups = incoming.tabGroups !== undefined
  let includeTabGroupLayouts = incoming.tabGroupLayouts !== undefined
  let rebasedMembership = false
  const worktreeIds = new Set([
    ...Object.keys(prior.tabsByWorktree),
    ...Object.keys(incoming.tabsByWorktree)
  ])
  for (const worktreeId of worktreeIds) {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const revision = terminalTopologyRevisionByRepoId[repoId] ?? 0
    const priorRevision = prior.terminalTopologyRevisionByRepoId[repoId] ?? 0
    const incomingRevision = incoming.terminalTopologyRevisionByRepoId?.[repoId] ?? 0
    if (revision <= 0 || incomingRevision > priorRevision) {
      continue
    }
    rebasedMembership = true
    const currentTabs = prior.tabsByWorktree[worktreeId] ?? []
    const candidateTabsById = new Map(
      (incoming.tabsByWorktree[worktreeId] ?? []).map((tab) => [tab.id, tab])
    )
    const terminalTabIds = new Set(currentTabs.map((tab) => tab.id))
    const tabs = currentTabs.map((current) => {
      const candidate = candidateTabsById.get(current.id)
      return candidate ? { ...candidate, ptyId: current.ptyId } : current
    })
    for (const candidate of incoming.tabsByWorktree[worktreeId] ?? []) {
      if (!terminalTabIds.has(candidate.id)) {
        delete terminalLayoutsByTabId[candidate.id]
      }
    }
    for (const tabId of terminalTabIds) {
      const layout = rebaseLayout(
        incoming.terminalLayoutsByTabId[tabId],
        prior.terminalLayoutsByTabId[tabId]
      )
      if (layout) {
        terminalLayoutsByTabId[tabId] = layout
      } else {
        delete terminalLayoutsByTabId[tabId]
      }
    }
    const rebasedUnifiedTabs = rebaseUnifiedTabs(
      incoming.unifiedTabs?.[worktreeId] ?? [],
      prior.unifiedTabs?.[worktreeId] ?? [],
      terminalTabIds
    )
    if (includeUnifiedTabs || rebasedUnifiedTabs.length > 0) {
      unifiedTabs[worktreeId] = rebasedUnifiedTabs
      includeUnifiedTabs = true
    }
    const validTabIds = new Set([...terminalTabIds, ...rebasedUnifiedTabs.map((tab) => tab.id)])
    const rebasedGroups = rebaseTabGroups(
      incoming.tabGroups?.[worktreeId] ?? prior.tabGroups?.[worktreeId] ?? [],
      validTabIds
    )
    if (includeTabGroups || rebasedGroups.length > 0) {
      tabGroups[worktreeId] = rebasedGroups
      includeTabGroups = true
    }
    const rebasedGroupLayout = pruneTabGroupLayoutAfterRetirement(
      incoming.tabGroupLayouts?.[worktreeId] ?? prior.tabGroupLayouts?.[worktreeId],
      new Set(rebasedGroups.map((group) => group.id))
    )
    if (rebasedGroupLayout) {
      tabGroupLayouts[worktreeId] = rebasedGroupLayout
      includeTabGroupLayouts = true
    } else {
      delete tabGroupLayouts[worktreeId]
    }
    if (!validTabIds.has(activeTabIdByWorktree[worktreeId] ?? '')) {
      activeTabIdByWorktree[worktreeId] =
        (prior.activeTabIdByWorktree?.[worktreeId] &&
        validTabIds.has(prior.activeTabIdByWorktree[worktreeId] ?? '')
          ? prior.activeTabIdByWorktree[worktreeId]
          : (rebasedGroups[0]?.activeTabId ?? tabs[0]?.id)) ?? null
    }
    tabsByWorktree[worktreeId] = tabs
  }
  const next: WorkspaceSessionState = {
    ...incoming,
    terminalTopologyRevisionByRepoId,
    ...(rebasedMembership
      ? {
          tabsByWorktree,
          terminalLayoutsByTabId,
          activeTabIdByWorktree,
          ...(includeUnifiedTabs ? { unifiedTabs } : {}),
          ...(includeTabGroups ? { tabGroups } : {}),
          ...(includeTabGroupLayouts ? { tabGroupLayouts } : {})
        }
      : {})
  }
  return rebasedMembership
    ? { ...next, terminalPtyIncarnationsByPaneKey: rebaseIncarnationBindings(next, prior) }
    : next
}
