import type { TerminalWindowTransferSeed } from '../../shared/terminal-window-transfer'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'

function workspaceKeys(workspaceId: string): string[] {
  const scope = parseWorkspaceKey(workspaceId)
  return scope?.type === 'worktree' ? [workspaceId, scope.worktreeId] : [workspaceId]
}

function hasWorkspaceContent(state: WorkspaceSessionState, workspaceId: string): boolean {
  return workspaceKeys(workspaceId).some(
    (key) =>
      Boolean(state.tabsByWorktree[key]?.length) ||
      Boolean(state.unifiedTabs?.[key]?.length) ||
      Boolean(state.openFilesByWorktree?.[key]?.length) ||
      Boolean(state.browserTabsByWorktree?.[key]?.length) ||
      Boolean(state.tabGroups?.[key]?.some(({ tabOrder }) => tabOrder.length > 0))
  )
}

function hasTab(state: WorkspaceSessionState, tabId: string, workspaceId?: string): boolean {
  const keys = workspaceId
    ? workspaceKeys(workspaceId)
    : [
        ...new Set([
          ...Object.keys(state.tabsByWorktree),
          ...Object.keys(state.unifiedTabs ?? {}),
          ...Object.keys(state.openFilesByWorktree ?? {}),
          ...Object.keys(state.browserTabsByWorktree ?? {})
        ])
      ]
  return keys.some(
    (key) =>
      state.tabsByWorktree[key]?.some(({ id }) => id === tabId) ||
      state.unifiedTabs?.[key]?.some(({ id, entityId }) => id === tabId || entityId === tabId) ||
      state.openFilesByWorktree?.[key]?.some(({ filePath }) => filePath === tabId) ||
      state.browserTabsByWorktree?.[key]?.some(({ id }) => id === tabId)
  )
}

function pickTab(
  state: WorkspaceSessionState,
  current: string | null | undefined,
  prior: string | null | undefined,
  transferredTabId: string,
  workspaceId: string | undefined,
  fallbackToTransfer: boolean
): string | null {
  if (current && current !== transferredTabId && hasTab(state, current, workspaceId)) {
    return current
  }
  if (prior) {
    return prior
  }
  return fallbackToTransfer && hasTab(state, transferredTabId, workspaceId)
    ? transferredTabId
    : null
}

function hasGroup(state: WorkspaceSessionState, workspaceId: string, groupId?: string): boolean {
  return Boolean(groupId && state.tabGroups?.[workspaceId]?.some(({ id }) => id === groupId))
}

export function reconcileTerminalTransferSelectors(
  next: WorkspaceSessionState,
  current: WorkspaceSessionState,
  prior: WorkspaceSessionState,
  seed: TerminalWindowTransferSeed,
  options: {
    createdTarget?: boolean
    fallbackToTransfer?: boolean
    targetGroupId?: string
  }
): void {
  if (options.createdTarget) {
    next.activeRepoId = seed.repo.id
    next.activeWorktreeId = seed.worktreeId
    next.activeTabId = seed.tabId
    next.activeTabIdByWorktree = { ...next.activeTabIdByWorktree, [seed.worktreeId]: seed.tabId }
    next.activeTabTypeByWorktree = {
      ...next.activeTabTypeByWorktree,
      [seed.worktreeId]: 'terminal'
    }
    next.activeGroupIdByWorktree = {
      ...next.activeGroupIdByWorktree,
      [seed.worktreeId]: options.targetGroupId ?? seed.group.id
    }
    return
  }

  next.activeTabId = pickTab(
    next,
    current.activeTabId,
    prior.activeTabId,
    seed.tabId,
    undefined,
    options.fallbackToTransfer === true
  )
  const currentWorkspaceTab = current.activeTabIdByWorktree?.[seed.worktreeId]
  const priorWorkspaceTab = prior.activeTabIdByWorktree?.[seed.worktreeId]
  const workspaceTab = pickTab(
    next,
    currentWorkspaceTab,
    priorWorkspaceTab,
    seed.tabId,
    seed.worktreeId,
    options.fallbackToTransfer === true
  )
  const priorHasWorkspaceTab = Object.hasOwn(prior.activeTabIdByWorktree ?? {}, seed.worktreeId)
  if (workspaceTab || priorHasWorkspaceTab || options.fallbackToTransfer) {
    next.activeTabIdByWorktree = { ...next.activeTabIdByWorktree }
    next.activeTabIdByWorktree[seed.worktreeId] = workspaceTab
  } else if (next.activeTabIdByWorktree) {
    const tabs = { ...next.activeTabIdByWorktree }
    delete tabs[seed.worktreeId]
    if (Object.keys(tabs).length > 0 || prior.activeTabIdByWorktree) {
      next.activeTabIdByWorktree = tabs
    } else {
      delete next.activeTabIdByWorktree
    }
  }
  next.activeTabTypeByWorktree = { ...next.activeTabTypeByWorktree }
  const activeType =
    workspaceTab === seed.tabId
      ? 'terminal'
      : workspaceTab === currentWorkspaceTab
        ? current.activeTabTypeByWorktree?.[seed.worktreeId]
        : prior.activeTabTypeByWorktree?.[seed.worktreeId]
  if (activeType) {
    next.activeTabTypeByWorktree[seed.worktreeId] = activeType
  } else {
    delete next.activeTabTypeByWorktree[seed.worktreeId]
  }

  next.activeRepoId =
    current.activeRepoId && current.activeRepoId !== seed.repo.id
      ? current.activeRepoId
      : (prior.activeRepoId ?? (options.fallbackToTransfer ? seed.repo.id : null))
  next.activeWorktreeId =
    (current.activeWorktreeId && hasWorkspaceContent(next, current.activeWorktreeId)
      ? current.activeWorktreeId
      : null) ??
    prior.activeWorktreeId ??
    (options.fallbackToTransfer ? seed.worktreeId : null)

  const currentGroupId = current.activeGroupIdByWorktree?.[seed.worktreeId]
  const priorGroupId = prior.activeGroupIdByWorktree?.[seed.worktreeId]
  const groupId = hasGroup(next, seed.worktreeId, currentGroupId)
    ? currentGroupId
    : (priorGroupId ??
      (options.fallbackToTransfer && hasGroup(next, seed.worktreeId, options.targetGroupId)
        ? options.targetGroupId
        : undefined))
  if (groupId) {
    next.activeGroupIdByWorktree = { ...next.activeGroupIdByWorktree }
    next.activeGroupIdByWorktree[seed.worktreeId] = groupId
  } else if (next.activeGroupIdByWorktree) {
    const groups = { ...next.activeGroupIdByWorktree }
    delete groups[seed.worktreeId]
    if (Object.keys(groups).length > 0 || prior.activeGroupIdByWorktree) {
      next.activeGroupIdByWorktree = groups
    } else {
      delete next.activeGroupIdByWorktree
    }
  }
}
