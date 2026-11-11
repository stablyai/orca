import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { rebaseTerminalGroupPresentation } from './workspace-session-terminal-group-rebase'

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
    // Renderer metadata may move; PTY bindings remain host-authoritative.
    ptyIdsByLeafId: {
      ...candidate.ptyIdsByLeafId,
      ...current.ptyIdsByLeafId
    }
  }
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
  const incomingTerminalLayoutsByTabId = incoming.terminalLayoutsByTabId ?? {}
  const priorTerminalLayoutsByTabId = prior.terminalLayoutsByTabId ?? {}
  const terminalLayoutsByTabId = { ...incomingTerminalLayoutsByTabId }
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
        incomingTerminalLayoutsByTabId[tabId],
        priorTerminalLayoutsByTabId[tabId]
      )
      if (layout) {
        terminalLayoutsByTabId[tabId] = layout
      } else {
        delete terminalLayoutsByTabId[tabId]
      }
    }
    const presentation = rebaseTerminalGroupPresentation(
      incoming,
      prior,
      worktreeId,
      terminalTabIds
    )
    const {
      unifiedTabs: rebasedUnifiedTabs,
      groups: rebasedGroups,
      layout: rebasedGroupLayout,
      validIds: validTabIds
    } = presentation
    if (includeUnifiedTabs || rebasedUnifiedTabs.length > 0) {
      unifiedTabs[worktreeId] = rebasedUnifiedTabs
      includeUnifiedTabs = true
    }
    if (includeTabGroups || rebasedGroups.length > 0) {
      tabGroups[worktreeId] = rebasedGroups
      includeTabGroups = true
    }
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

/** Group/unified patches rebase only their changed workspace buckets, without pane normalization. */
export function rebaseWorkspaceSessionTerminalGroupPatch(
  incoming: WorkspaceSessionState,
  prior: WorkspaceSessionState,
  worktreeIds: ReadonlySet<string>
): WorkspaceSessionState {
  const originalUnifiedTabs = incoming.unifiedTabs ?? {}
  const originalGroups = incoming.tabGroups ?? {}
  const originalLayouts = incoming.tabGroupLayouts ?? {}
  let unifiedTabs = originalUnifiedTabs
  let tabGroups = originalGroups
  let tabGroupLayouts = originalLayouts
  for (const worktreeId of worktreeIds) {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const revision = prior.terminalTopologyRevisionByRepoId?.[repoId] ?? 0
    if (revision <= 0 || (incoming.terminalTopologyRevisionByRepoId?.[repoId] ?? 0) > revision) {
      continue
    }
    const presentation = rebaseTerminalGroupPresentation(
      incoming,
      prior,
      worktreeId,
      new Set((prior.tabsByWorktree?.[worktreeId] ?? []).map((tab) => tab.id))
    )
    if (
      presentation.unifiedTabs !== unifiedTabs?.[worktreeId] &&
      (unifiedTabs?.[worktreeId] !== undefined || presentation.unifiedTabs.length > 0)
    ) {
      if (unifiedTabs === originalUnifiedTabs) {
        unifiedTabs = { ...unifiedTabs }
      }
      unifiedTabs[worktreeId] = presentation.unifiedTabs
    }
    if (
      presentation.groups !== tabGroups?.[worktreeId] &&
      (tabGroups?.[worktreeId] !== undefined || presentation.groups.length > 0)
    ) {
      if (tabGroups === originalGroups) {
        tabGroups = { ...tabGroups }
      }
      tabGroups[worktreeId] = presentation.groups
    }
    if ((presentation.layout ?? undefined) !== tabGroupLayouts?.[worktreeId]) {
      if (tabGroupLayouts === originalLayouts) {
        tabGroupLayouts = { ...tabGroupLayouts }
      }
      if (presentation.layout) {
        tabGroupLayouts[worktreeId] = presentation.layout
      } else {
        delete tabGroupLayouts[worktreeId]
      }
    }
  }
  return unifiedTabs === originalUnifiedTabs &&
    tabGroups === originalGroups &&
    tabGroupLayouts === originalLayouts
    ? incoming
    : {
        ...incoming,
        ...(unifiedTabs !== originalUnifiedTabs ? { unifiedTabs } : {}),
        ...(tabGroups !== originalGroups ? { tabGroups } : {}),
        ...(tabGroupLayouts !== originalLayouts ? { tabGroupLayouts } : {})
      }
}
