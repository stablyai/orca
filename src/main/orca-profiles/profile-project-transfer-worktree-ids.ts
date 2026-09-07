import type { PersistedState } from '../../shared/persisted-state-types'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { TransferProfileState } from './profile-project-state-file'
import { isRepoWorktreeId } from './profile-project-worktree-identity'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../shared/worktree/host-qualified-identity'

export function collectTransferWorktreeIds(
  state: TransferProfileState,
  repoId: string
): Set<string> {
  const ids = new Set<string>()
  const add = (value: string | null | undefined): void => {
    if (value && isRepoWorktreeId(repoId, value)) {
      ids.add(value)
    }
  }
  Object.keys(state.worktreeMeta).forEach(add)
  for (const lineage of Object.values(state.worktreeLineageById)) {
    add(lineage.worktreeId)
    add(lineage.parentWorktreeId)
  }
  for (const [key, lineage] of Object.entries(state.workspaceLineageByChildKey)) {
    const child = parseWorkspaceKey(key)
    const parent = parseWorkspaceKey(lineage.parentWorkspaceKey)
    if (child?.type === 'worktree') {
      add(child.worktreeId)
    }
    if (parent?.type === 'worktree') {
      add(parent.worktreeId)
    }
  }
  collectSessionWorktreeIds(state.workspaceSession, repoId, ids)
  for (const session of Object.values(state.workspaceSessionsByHostId ?? {})) {
    collectSessionWorktreeIds(session, repoId, ids)
  }
  Object.keys(state.ui?.showDotfilesByWorktree ?? {}).forEach(add)
  return ids
}

function collectSessionWorktreeIds(
  session: PersistedState['workspaceSession'] | undefined,
  repoId: string,
  ids: Set<string>
): void {
  if (!session) {
    return
  }
  const add = (value: string | null | undefined): void => {
    if (value && isRepoWorktreeId(repoId, value)) {
      ids.add(value)
    }
  }
  const addOwnerKeys = (record: Record<string, unknown> | undefined): void => {
    for (const key of Object.keys(record ?? {})) {
      const rawKey = isWorktreeHostIdentity(key) ? getWorktreeIdFromHostIdentity(key) : key
      if (isRepoWorktreeId(repoId, rawKey)) {
        ids.add(rawKey)
      }
      const parsed = parseWorkspaceKey(key)
      if (parsed?.type === 'worktree' && isRepoWorktreeId(repoId, parsed.worktreeId)) {
        ids.add(parsed.worktreeId)
      }
    }
  }
  addOwnerKeys(session.tabsByWorktree)
  addOwnerKeys(session.openFilesByWorktree)
  addOwnerKeys(session.browserTabsByWorktree)
  addOwnerKeys(session.activeBrowserTabIdByWorktree)
  addOwnerKeys(session.activeTabTypeByWorktree)
  addOwnerKeys(session.activeTabIdByWorktree)
  addOwnerKeys(session.unifiedTabs)
  addOwnerKeys(session.tabGroups)
  addOwnerKeys(session.tabGroupLayouts)
  addOwnerKeys(session.activeGroupIdByWorktree)
  addOwnerKeys(session.lastVisitedAtByWorktreeId)
  addOwnerKeys(session.defaultTerminalTabsAppliedByWorktreeId)
  addOwnerKeys(session.terminalTopologyRevisionByRepoId)
  addOwnerKeys(session.activeFileIdByWorktree)
  for (const tombstone of Object.values(session.terminalSurfaceTombstonesByPaneKey ?? {})) {
    add(tombstone.worktreeId)
  }
  add(session.activeWorktreeId)
  const activeScope = session.activeWorkspaceKey
    ? parseWorkspaceKey(session.activeWorkspaceKey)
    : null
  if (activeScope?.type === 'worktree') {
    add(activeScope.worktreeId)
  }
}
