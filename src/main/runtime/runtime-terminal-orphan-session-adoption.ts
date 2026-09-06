import { randomUUID } from 'node:crypto'
import type { RuntimeTerminalOrphanAdoptionRequest } from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { collectPersistedTerminalLeafIds } from './mobile-session-layout-projection'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { getLatestPtyTitle } from './runtime-worktree-status-projection'
import { mergeTerminalOrphanGroupLayout } from './terminal-orphan-topology'
import { canonicalizeTerminalSessionWorktreeId } from './workspace-session-worktree-id'
import { advanceTerminalTopologyRevision } from './workspace-session-terminal-membership-authority'

type Claim = RuntimeTerminalOrphanAdoptionRequest['claims'][number]
type Topology = NonNullable<RuntimeTerminalOrphanAdoptionRequest['topology']>

export function buildRuntimeTerminalOrphanSession(args: {
  session: WorkspaceSessionState
  sessionWorktreeId: string
  worktreeId: string
  request: RuntimeTerminalOrphanAdoptionRequest
  validated: readonly { claim: Claim; pty: RuntimePtyWorktreeRecord; paneKey: string }[]
  topologyTabsById: ReadonlyMap<string, Topology['tabs'][number]>
  topologyGroups: Topology['groups']
}): WorkspaceSessionState {
  const {
    session,
    sessionWorktreeId,
    worktreeId,
    request,
    validated,
    topologyTabsById,
    topologyGroups
  } = args
  const next = structuredClone(session)
  canonicalizeTerminalSessionWorktreeId(next, sessionWorktreeId, worktreeId)
  const existingTabs = next.tabsByWorktree[worktreeId] ?? []
  const tabsById = new Map(existingTabs.map((tab) => [tab.id, tab]))
  for (const { claim, pty, paneKey } of validated) {
    let tab = tabsById.get(claim.tabId)
    if (!tab) {
      const title = getLatestPtyTitle(pty) ?? pty.controllerTitle ?? `Terminal ${tabsById.size + 1}`
      tab = {
        id: claim.tabId,
        ptyId: claim.ptyId,
        worktreeId: worktreeId,
        title,
        defaultTitle: title,
        customTitle: null,
        color: null,
        sortOrder: tabsById.size,
        createdAt: Date.now(),
        pendingActivationSpawn: true
      }
      tabsById.set(claim.tabId, tab)
    }
    const existingLayout = next.terminalLayoutsByTabId[claim.tabId]
    const topologyTab = topologyTabsById.get(claim.tabId)
    next.terminalLayoutsByTabId[claim.tabId] = topologyTab
      ? {
          ...existingLayout,
          root: topologyTab.root,
          activeLeafId: topologyTab.activeLeafId,
          expandedLeafId: topologyTab.expandedLeafId,
          ptyIdsByLeafId: {
            ...existingLayout?.ptyIdsByLeafId,
            [claim.leafId]: claim.ptyId
          }
        }
      : existingLayout
        ? {
            ...existingLayout,
            root: collectPersistedTerminalLeafIds(existingLayout).includes(claim.leafId)
              ? existingLayout.root
              : existingLayout.root === null
                ? { type: 'leaf', leafId: claim.leafId }
                : {
                    type: 'split',
                    direction: 'vertical',
                    first: existingLayout.root,
                    second: { type: 'leaf', leafId: claim.leafId }
                  },
            ptyIdsByLeafId: {
              ...existingLayout.ptyIdsByLeafId,
              [claim.leafId]: claim.ptyId
            }
          }
        : {
            root: { type: 'leaf', leafId: claim.leafId },
            activeLeafId: claim.leafId,
            expandedLeafId: null,
            ptyIdsByLeafId: { [claim.leafId]: claim.ptyId }
          }
    next.terminalPtyIncarnationsByPaneKey = {
      ...next.terminalPtyIncarnationsByPaneKey,
      [paneKey]: claim.incarnationId
    }
  }
  const adoptedTabIds = [...new Set(validated.map(({ claim }) => claim.tabId))]
  next.tabsByWorktree[worktreeId] = [...tabsById.values()]
  const activeTabId =
    request.activeTabId && tabsById.has(request.activeTabId)
      ? request.activeTabId
      : (adoptedTabIds[0] ?? null)
  const existingGroups = next.tabGroups?.[worktreeId] ?? []
  const targetGroupId =
    (request.activeGroupId && existingGroups.some((group) => group.id === request.activeGroupId)
      ? request.activeGroupId
      : existingGroups[0]?.id) ??
    request.activeGroupId ??
    randomUUID()
  const proposedGroups = topologyGroups.map((group) => ({
    ...group,
    worktreeId: worktreeId
  }))
  const groups =
    existingGroups.length === 0 && proposedGroups.length > 0
      ? proposedGroups
      : existingGroups.length > 0
        ? existingGroups
            .map((group) => {
              const proposed = proposedGroups.find((candidate) => candidate.id === group.id)
              const tabOrder = proposed
                ? [
                    ...group.tabOrder.filter((tabId) => !adoptedTabIds.includes(tabId)),
                    ...proposed.tabOrder
                  ]
                : group.id === targetGroupId && proposedGroups.length === 0
                  ? [...new Set([...group.tabOrder, ...adoptedTabIds])]
                  : group.tabOrder.filter((tabId) => !adoptedTabIds.includes(tabId))
              return {
                ...group,
                tabOrder,
                activeTabId: proposed
                  ? proposed.activeTabId
                  : group.id === targetGroupId && activeTabId
                    ? activeTabId
                    : group.activeTabId && tabOrder.includes(group.activeTabId)
                      ? group.activeTabId
                      : (tabOrder[0] ?? null),
                ...(proposed?.recentTabIds ? { recentTabIds: proposed.recentTabIds } : {})
              }
            })
            .concat(
              proposedGroups.filter(
                (proposed) => !existingGroups.some((group) => group.id === proposed.id)
              )
            )
        : [{ id: targetGroupId, worktreeId: worktreeId, activeTabId, tabOrder: adoptedTabIds }]
  const retainedGroups = groups.filter((group) => group.tabOrder.length > 0)
  next.tabGroups = {
    ...next.tabGroups,
    [worktreeId]: retainedGroups
  }
  const mergedGroupLayout = mergeTerminalOrphanGroupLayout({
    existingLayout: next.tabGroupLayouts?.[worktreeId],
    existingGroupIds: existingGroups.map((group) => group.id),
    proposedLayout: request.topology?.groupLayout,
    proposedGroupIds: proposedGroups.map((group) => group.id),
    mergedGroupIds: retainedGroups.map((group) => group.id)
  })
  if (mergedGroupLayout) {
    next.tabGroupLayouts = {
      ...next.tabGroupLayouts,
      [worktreeId]: mergedGroupLayout
    }
  }
  const activeGroup =
    (request.activeGroupId
      ? retainedGroups.find(
          (group) =>
            group.id === request.activeGroupId &&
            (!activeTabId || group.tabOrder.includes(activeTabId))
        )
      : undefined) ??
    retainedGroups.find((group) => activeTabId && group.tabOrder.includes(activeTabId)) ??
    retainedGroups[0]!
  const convergedActiveTabId =
    activeTabId && activeGroup.tabOrder.includes(activeTabId)
      ? activeTabId
      : activeGroup.activeTabId
  next.activeTabIdByWorktree = {
    ...next.activeTabIdByWorktree,
    ...(convergedActiveTabId ? { [worktreeId]: convergedActiveTabId } : {})
  }
  next.activeGroupIdByWorktree = {
    ...next.activeGroupIdByWorktree,
    [worktreeId]: activeGroup.id
  }
  const persisted = advanceTerminalTopologyRevision(next, worktreeId)
  return persisted
}
