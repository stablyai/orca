import type { Tab, TabGroup } from '../../shared/tab-types'
import type { TerminalWindowTransferSeed } from '../../shared/terminal-window-transfer'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { appendMissingGroup } from './terminal-window-transfer-session-patch'
import { reconcileTerminalTransferSelectors } from './terminal-window-transfer-session-selectors'

function withoutTransferredTab<T extends { id: string }>(items: readonly T[], tabId: string): T[] {
  return items.filter(({ id }) => id !== tabId)
}

function chooseTargetGroup(
  current: WorkspaceSessionState,
  targetBefore: WorkspaceSessionState,
  seed: TerminalWindowTransferSeed,
  createdTarget: boolean
): { group: TabGroup; existed: boolean } {
  const groups = current.tabGroups?.[seed.worktreeId] ?? []
  const activeGroupId =
    current.activeGroupIdByWorktree?.[seed.worktreeId] ??
    targetBefore.activeGroupIdByWorktree?.[seed.worktreeId]
  const existing =
    groups.find(({ id }) => id === activeGroupId) ?? groups.find(({ id }) => id === seed.group.id)
  const base = existing ?? {
    ...structuredClone(seed.group),
    activeTabId: null,
    tabOrder: [],
    recentTabIds: []
  }
  const tabOrder = [...base.tabOrder.filter((id) => id !== seed.tabId), seed.tabId]
  const recentTabIds = [...(base.recentTabIds ?? []).filter((id) => id !== seed.tabId), seed.tabId]
  return {
    group: {
      ...base,
      activeTabId: createdTarget ? seed.tabId : (base.activeTabId ?? seed.tabId),
      tabOrder,
      recentTabIds
    },
    existed: Boolean(existing)
  }
}

function buildUnifiedTerminalTab(
  source: WorkspaceSessionState,
  seed: TerminalWindowTransferSeed,
  groupId: string,
  sortOrder: number
): Tab {
  const existing = Object.values(source.unifiedTabs ?? {})
    .flat()
    .find(({ id, entityId }) => id === seed.tabId || entityId === seed.tabId)
  return {
    ...(existing ?? {
      customLabel: seed.tab.customTitle,
      color: seed.tab.color,
      createdAt: seed.tab.createdAt,
      label: seed.tab.title
    }),
    id: seed.tabId,
    entityId: seed.tabId,
    groupId,
    worktreeId: seed.worktreeId,
    contentType: 'terminal',
    sortOrder
  }
}

export function importTransferredTerminalSession(
  current: WorkspaceSessionState,
  targetBefore: WorkspaceSessionState,
  sourceBefore: WorkspaceSessionState,
  seed: TerminalWindowTransferSeed,
  createdTarget: boolean
): WorkspaceSessionState {
  const next = structuredClone(current)
  for (const [key, tabs] of Object.entries(next.tabsByWorktree)) {
    next.tabsByWorktree[key] = withoutTransferredTab(tabs, seed.tabId)
  }
  next.tabsByWorktree[seed.worktreeId] = [
    ...(next.tabsByWorktree[seed.worktreeId] ?? []),
    structuredClone(seed.tab)
  ]
  next.terminalLayoutsByTabId[seed.tabId] = structuredClone(seed.layout)

  const { group, existed } = chooseTargetGroup(next, targetBefore, seed, createdTarget)
  next.tabGroups ??= {}
  const groups = next.tabGroups[seed.worktreeId] ?? []
  next.tabGroups[seed.worktreeId] = existed
    ? groups.map((candidate) => (candidate.id === group.id ? group : candidate))
    : [...groups, group]
  next.tabGroupLayouts ??= {}
  next.tabGroupLayouts[seed.worktreeId] = appendMissingGroup(
    next.tabGroupLayouts[seed.worktreeId],
    group.id
  )

  for (const [key, tabs] of Object.entries(next.unifiedTabs ?? {})) {
    next.unifiedTabs![key] = tabs.filter(
      ({ id, entityId }) => id !== seed.tabId && entityId !== seed.tabId
    )
  }
  next.unifiedTabs ??= {}
  next.unifiedTabs[seed.worktreeId] = [
    ...(next.unifiedTabs[seed.worktreeId] ?? []),
    buildUnifiedTerminalTab(sourceBefore, seed, group.id, group.tabOrder.indexOf(seed.tabId))
  ]

  const remoteSessionId = sourceBefore.remoteSessionIdsByTabId?.[seed.tabId]
  next.remoteSessionIdsByTabId = { ...next.remoteSessionIdsByTabId }
  if (remoteSessionId !== undefined) {
    next.remoteSessionIdsByTabId[seed.tabId] = remoteSessionId
  } else {
    delete next.remoteSessionIdsByTabId[seed.tabId]
  }

  reconcileTerminalTransferSelectors(next, current, targetBefore, seed, {
    createdTarget,
    fallbackToTransfer: true,
    targetGroupId: group.id
  })
  if (createdTarget) {
    next.activeWorkspaceKey = seed.canonicalWorkspaceKey
    next.activeWorkspaceExecutionHostId = seed.hostId
  }
  return next
}
