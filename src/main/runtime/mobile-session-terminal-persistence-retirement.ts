import type { WorkspaceSessionState, WorkspaceVisibleTabType } from '../../shared/types'
import {
  pruneTabGroupLayoutAfterRetirement,
  repairMobileSessionTabGroupsAfterRetirement,
  retireLeavesFromTerminalLayout,
  type RetiredTerminalSurface
} from './mobile-session-terminal-retirement'
import {
  advanceTerminalTopologyRevision,
  rebaseWorkspaceSessionTerminalMembership
} from './workspace-session-terminal-membership-authority'

function visibleTypeForContentType(
  contentType: string | undefined
): WorkspaceVisibleTabType | undefined {
  if (contentType === 'terminal') {
    return 'terminal'
  }
  if (contentType === 'browser') {
    return 'browser'
  }
  if (contentType === 'simulator') {
    return 'simulator'
  }
  return contentType ? 'editor' : undefined
}

function layoutContainsLeaf(
  node: WorkspaceSessionState['terminalLayoutsByTabId'][string]['root'],
  leafId: string
): boolean {
  if (!node) {
    return false
  }
  return node.type === 'leaf'
    ? node.leafId === leafId
    : layoutContainsLeaf(node.first, leafId) || layoutContainsLeaf(node.second, leafId)
}

function recordTerminalSurfaceRetirement(
  session: WorkspaceSessionState,
  surface: RetiredTerminalSurface,
  paneKey: string
): WorkspaceSessionState {
  const terminalPtyIncarnationsByPaneKey = {
    ...session.terminalPtyIncarnationsByPaneKey
  }
  delete terminalPtyIncarnationsByPaneKey[paneKey]
  const terminalSurfaceTombstonesByPaneKey = {
    ...session.terminalSurfaceTombstonesByPaneKey
  }
  delete terminalSurfaceTombstonesByPaneKey[paneKey]
  return advanceTerminalTopologyRevision(
    {
      ...session,
      terminalPtyIncarnationsByPaneKey,
      terminalSurfaceTombstonesByPaneKey
    },
    surface.worktreeId
  )
}

export function retireTerminalSurfaceFromPersistence(
  session: WorkspaceSessionState,
  surface: RetiredTerminalSurface
): WorkspaceSessionState {
  const paneKey = `${surface.parentTabId}:${surface.leafId}`
  const boundIncarnationId = session.terminalPtyIncarnationsByPaneKey?.[paneKey]
  if (surface.incarnationId && boundIncarnationId && boundIncarnationId !== surface.incarnationId) {
    return session
  }
  const persistedTabs = session.tabsByWorktree[surface.worktreeId] ?? []
  const persistedTab = persistedTabs.find((tab) => tab.id === surface.parentTabId)
  const layout = session.terminalLayoutsByTabId[surface.parentTabId]
  const exactLeafInLayout = Boolean(layout && layoutContainsLeaf(layout.root, surface.leafId))
  const leafPtyId = exactLeafInLayout ? layout?.ptyIdsByLeafId?.[surface.leafId] : undefined
  if (leafPtyId && leafPtyId !== surface.ptyId) {
    return session
  }

  const isLegacyFinalSurface = !layout && persistedTab?.ptyId === surface.ptyId
  if (!exactLeafInLayout && !isLegacyFinalSurface) {
    // Why: tab.ptyId may describe a live sibling. The absent exact leaf still
    // needs a tombstone, but sibling evidence must not remove its parent.
    return recordTerminalSurfaceRetirement(session, surface, paneKey)
  }

  const nextLayout =
    exactLeafInLayout && layout
      ? retireLeavesFromTerminalLayout(layout, new Set([surface.leafId]))
      : null
  const removeParent = !nextLayout
  const nextTabsForWorktree = removeParent
    ? persistedTabs.filter((tab) => tab.id !== surface.parentTabId)
    : persistedTabs.map((tab) =>
        tab.id === surface.parentTabId
          ? {
              ...tab,
              ptyId:
                nextLayout.ptyIdsByLeafId?.[nextLayout.activeLeafId ?? ''] ??
                Object.values(nextLayout.ptyIdsByLeafId ?? {})[0] ??
                null
            }
          : tab
      )
  const terminalLayoutsByTabId = { ...session.terminalLayoutsByTabId }
  if (nextLayout) {
    terminalLayoutsByTabId[surface.parentTabId] = nextLayout
  } else {
    delete terminalLayoutsByTabId[surface.parentTabId]
  }

  const unifiedTabsForWorktree = session.unifiedTabs?.[surface.worktreeId] ?? []
  const unifiedTabs = session.unifiedTabs
    ? {
        ...session.unifiedTabs,
        [surface.worktreeId]: removeParent
          ? unifiedTabsForWorktree.filter(
              (tab) => tab.id !== surface.parentTabId && tab.entityId !== surface.parentTabId
            )
          : unifiedTabsForWorktree
      }
    : undefined
  const validTopLevelIds = new Set((unifiedTabs?.[surface.worktreeId] ?? []).map((tab) => tab.id))
  for (const tab of nextTabsForWorktree) {
    validTopLevelIds.add(tab.id)
  }
  const persistedGroups = session.tabGroups?.[surface.worktreeId]
  const repairedGroups = repairMobileSessionTabGroupsAfterRetirement(
    persistedGroups,
    validTopLevelIds
  )
  const tabGroups = session.tabGroups
    ? {
        ...session.tabGroups,
        [surface.worktreeId]: (repairedGroups ?? []).map((group) => ({
          ...group,
          worktreeId: surface.worktreeId
        }))
      }
    : undefined
  const retainedGroupIds = new Set(repairedGroups?.map((group) => group.id) ?? [])
  const repairedGroupLayout = pruneTabGroupLayoutAfterRetirement(
    session.tabGroupLayouts?.[surface.worktreeId],
    retainedGroupIds
  )
  const tabGroupLayouts = session.tabGroupLayouts ? { ...session.tabGroupLayouts } : undefined
  if (tabGroupLayouts) {
    if (repairedGroupLayout) {
      tabGroupLayouts[surface.worktreeId] = repairedGroupLayout
    } else {
      delete tabGroupLayouts[surface.worktreeId]
    }
  }

  const previousActiveTabId = session.activeTabIdByWorktree?.[surface.worktreeId]
  const activeTabStillExists = previousActiveTabId && validTopLevelIds.has(previousActiveTabId)
  const nextActiveTabId =
    (activeTabStillExists ? previousActiveTabId : undefined) ??
    repairedGroups?.find(
      (group) => group.id === session.activeGroupIdByWorktree?.[surface.worktreeId]
    )?.activeTabId ??
    repairedGroups?.[0]?.activeTabId ??
    [...validTopLevelIds][0] ??
    null
  const activeTabIdByWorktree = {
    ...session.activeTabIdByWorktree,
    [surface.worktreeId]: nextActiveTabId
  }
  const activeTabTypeByWorktree = { ...session.activeTabTypeByWorktree }
  const activeUnifiedTab = unifiedTabs?.[surface.worktreeId]?.find(
    (tab) => tab.id === nextActiveTabId
  )
  const nextActiveType = visibleTypeForContentType(activeUnifiedTab?.contentType)
  if (nextActiveType) {
    activeTabTypeByWorktree[surface.worktreeId] = nextActiveType
  } else if (!nextActiveTabId) {
    delete activeTabTypeByWorktree[surface.worktreeId]
  }
  const activeGroupIdByWorktree = { ...session.activeGroupIdByWorktree }
  const nextActiveGroupId =
    repairedGroups?.find((group) => group.tabOrder.includes(nextActiveTabId ?? ''))?.id ??
    repairedGroups?.[0]?.id
  if (nextActiveGroupId) {
    activeGroupIdByWorktree[surface.worktreeId] = nextActiveGroupId
  } else {
    delete activeGroupIdByWorktree[surface.worktreeId]
  }
  const remoteSessionIdsByTabId = { ...session.remoteSessionIdsByTabId }
  if (removeParent) {
    delete remoteSessionIdsByTabId[surface.parentTabId]
  } else if (remoteSessionIdsByTabId[surface.parentTabId] === surface.ptyId) {
    remoteSessionIdsByTabId[surface.parentTabId] =
      nextLayout?.ptyIdsByLeafId?.[nextLayout.activeLeafId ?? ''] ??
      Object.values(nextLayout?.ptyIdsByLeafId ?? {})[0] ??
      ''
    if (!remoteSessionIdsByTabId[surface.parentTabId]) {
      delete remoteSessionIdsByTabId[surface.parentTabId]
    }
  }
  return recordTerminalSurfaceRetirement(
    {
      ...session,
      activeTabId:
        session.activeTabId === surface.parentTabId ? nextActiveTabId : session.activeTabId,
      tabsByWorktree: {
        ...session.tabsByWorktree,
        [surface.worktreeId]: nextTabsForWorktree
      },
      terminalLayoutsByTabId,
      activeTabIdByWorktree,
      ...(unifiedTabs ? { unifiedTabs } : {}),
      ...(tabGroups ? { tabGroups } : {}),
      ...(tabGroupLayouts ? { tabGroupLayouts } : {}),
      ...(session.activeGroupIdByWorktree ? { activeGroupIdByWorktree } : {}),
      ...(session.activeTabTypeByWorktree ? { activeTabTypeByWorktree } : {}),
      ...(session.remoteSessionIdsByTabId ? { remoteSessionIdsByTabId } : {})
    },
    surface,
    paneKey
  )
}

export function sanitizeWorkspaceSessionTerminalRetirements(
  incoming: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined
): WorkspaceSessionState {
  if (
    !prior?.terminalSurfaceTombstonesByPaneKey &&
    !incoming.terminalSurfaceTombstonesByPaneKey &&
    !prior?.terminalTopologyRevisionByRepoId
  ) {
    return incoming
  }
  const bindings = {
    ...prior?.terminalPtyIncarnationsByPaneKey,
    ...incoming.terminalPtyIncarnationsByPaneKey
  }
  const tombstones = {
    ...prior?.terminalSurfaceTombstonesByPaneKey,
    ...incoming.terminalSurfaceTombstonesByPaneKey
  }
  const hasLegacyTombstones = Object.keys(tombstones).length > 0
  let next: WorkspaceSessionState = {
    ...incoming,
    terminalPtyIncarnationsByPaneKey: hasLegacyTombstones
      ? bindings
      : incoming.terminalPtyIncarnationsByPaneKey,
    terminalSurfaceTombstonesByPaneKey: tombstones
  }
  for (const tombstone of Object.values(tombstones)) {
    next = retireTerminalSurfaceFromPersistence(next, tombstone)
  }
  return rebaseWorkspaceSessionTerminalMembership(
    { ...next, terminalSurfaceTombstonesByPaneKey: {} },
    prior
  )
}
