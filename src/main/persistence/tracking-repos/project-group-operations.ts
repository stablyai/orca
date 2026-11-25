import type { ProfileSaveDomains } from '../profile-save-domains'
import { WORKSPACE_SESSION_DOMAINS } from '../workspace-session-domains'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import type {
  ProjectGroup,
  ProjectGroupMutation,
  ProjectGroupParentMove,
  ProjectGroupUpdate
} from '../../../shared/project/groups/project-group-types'
import {
  createProjectGroup,
  getProjectGroupSubtreeIds,
  normalizeProjectGroupName
} from '../../../shared/project/groups/project-groups'
import { canMoveProjectGroup } from '../../../shared/project/groups/project-group-nesting'
import { normalizeProjectGroupRemoteMembers } from '../../../shared/project/groups/project-group-remote-members'
import { getNextRootProjectOrder } from '../../../shared/sidebar-list/sections/root-project-order'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { removeWorkspaceSessionOwnersEverywhere } from '../restoring-sessions/session-owner-removal'

export type ProjectGroupMutationOperations = {
  state: PersistedState
  scheduleSave: (domains: ProfileSaveDomains) => void
  removeWorkspaceLineageForRemovedFolder: (folderWorkspaceId: string) => void
  pruneMobileClientTabSelections: (matchesWorktreeId: (worktreeId: string) => boolean) => void
}

const projectGroupIndexes = new WeakMap<
  readonly ProjectGroup[],
  { length: number; byId: Map<string, ProjectGroup> }
>()

export class ProjectGroupPersistenceOperations {
  constructor(private readonly operations: ProjectGroupMutationOperations) {}

  private get state(): PersistedState {
    return this.operations.state
  }

  private scheduleSave(domains: ProfileSaveDomains): void {
    this.operations.scheduleSave(domains)
  }

  private removeWorkspaceLineageForRemovedFolder(folderWorkspaceId: string): void {
    this.operations.removeWorkspaceLineageForRemovedFolder(folderWorkspaceId)
  }

  private pruneMobileClientTabSelections(matchesWorktreeId: (worktreeId: string) => boolean): void {
    this.operations.pruneMobileClientTabSelections(matchesWorktreeId)
  }

  /** One group by id, without copying and sorting the whole list. */
  getProjectGroup(id: string): ProjectGroup | undefined {
    const groups = this.state.projectGroups
    if (!groups) {
      return undefined
    }
    // Rebuilt when the list is replaced or appended to in place; renames edit the indexed objects.
    let index = projectGroupIndexes.get(groups)
    if (!index || index.length !== groups.length) {
      index = { length: groups.length, byId: new Map(groups.map((group) => [group.id, group])) }
      projectGroupIndexes.set(groups, index)
    }
    return index.byId.get(id)
  }

  getProjectGroups(): ProjectGroup[] {
    return [...(this.state.projectGroups ?? [])].sort(
      (left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
    )
  }

  createProjectGroup(input: {
    name: string
    parentPath?: string | null
    connectionId?: string | null
    parentGroupId?: string | null
    createdFrom: ProjectGroup['createdFrom']
  }): ProjectGroup {
    let maxOrder = -1
    // Large persisted lists can exceed spread argument limits.
    for (const existingGroup of this.state.projectGroups ?? []) {
      maxOrder = Math.max(maxOrder, existingGroup.tabOrder)
    }
    const group = createProjectGroup({
      ...input,
      tabOrder: maxOrder + 1
    })
    const rootProjectOrder = !group.parentGroupId
      ? getNextRootProjectOrder(this.state.repos, this.state.projectGroups ?? [])
      : undefined
    if (rootProjectOrder !== undefined) {
      group.rootProjectOrder = rootProjectOrder
    }
    this.state.projectGroups = [...(this.state.projectGroups ?? []), group]
    this.scheduleSave(['projectGroups'])
    return group
  }

  updateProjectGroup(groupId: string, updates: ProjectGroupUpdate): ProjectGroup | null {
    const group = (this.state.projectGroups ?? []).find((entry) => entry.id === groupId)
    if (!group || !this.canApplyParentMoves([{ groupId, updates }])) {
      return null
    }
    this.applyGroupUpdate(group, updates)
    this.scheduleSave(['projectGroups'])
    return group
  }

  updateProjectGroups(mutations: readonly ProjectGroupMutation[]): ProjectGroup[] | null {
    const byId = new Map((this.state.projectGroups ?? []).map((group) => [group.id, group]))
    if (
      mutations.some(({ groupId }) => !byId.has(groupId)) ||
      !this.canApplyParentMoves(mutations)
    ) {
      return null
    }
    const updated = mutations.map(({ groupId, updates }) => {
      const group = byId.get(groupId)!
      this.applyGroupUpdate(group, updates)
      return group
    })
    if (updated.length > 0) {
      this.scheduleSave(['projectGroups'])
    }
    return updated
  }

  /** Moves nested groups under other groups in order, skipping unknown groups and moves that would form a cycle. */
  setProjectGroupParents(moves: readonly ProjectGroupParentMove[]): ProjectGroup[] {
    const byId = new Map((this.state.projectGroups ?? []).map((group) => [group.id, group]))
    const moved: ProjectGroup[] = []
    for (const { groupId, parentGroupId } of moves) {
      const group = byId.get(groupId)
      if (!group || !byId.has(parentGroupId) || group.parentGroupId === parentGroupId) {
        continue
      }
      // A cycle exists if the group is the new parent or one of its ancestors.
      const visited = new Set<string>()
      let ancestor = byId.get(parentGroupId)
      while (ancestor && ancestor.id !== groupId && !visited.has(ancestor.id)) {
        visited.add(ancestor.id)
        ancestor = ancestor.parentGroupId ? byId.get(ancestor.parentGroupId) : undefined
      }
      if (ancestor?.id === groupId) {
        continue
      }
      group.parentGroupId = parentGroupId
      group.updatedAt = Date.now()
      moved.push(group)
    }
    if (moved.length > 0) {
      this.scheduleSave(['projectGroups'])
    }
    return moved
  }

  /** False when any parent change, applied in order, would form a cycle or pass the nesting limit. */
  private canApplyParentMoves(mutations: readonly ProjectGroupMutation[]): boolean {
    const links = (this.state.projectGroups ?? []).map(({ id, parentGroupId }) => ({
      id,
      parentGroupId
    }))
    for (const { groupId, updates } of mutations) {
      const link = links.find((entry) => entry.id === groupId)
      const parentGroupId = updates.parentGroupId
      if (!link || parentGroupId === undefined || link.parentGroupId === parentGroupId) {
        continue
      }
      if (!canMoveProjectGroup(links, groupId, parentGroupId)) {
        return false
      }
      link.parentGroupId = parentGroupId
    }
    return true
  }

  private applyGroupUpdate(group: ProjectGroup, updates: ProjectGroupUpdate): void {
    if (updates.parentGroupId !== undefined && updates.parentGroupId !== group.parentGroupId) {
      group.parentGroupId = updates.parentGroupId
      // Why: only top-level entries hold a root order slot, so a group leaving its parent needs one.
      if (updates.parentGroupId !== null) {
        delete group.rootProjectOrder
      } else if (updates.rootProjectOrder === undefined) {
        const rootProjectOrder = getNextRootProjectOrder(
          this.state.repos,
          this.state.projectGroups ?? []
        )
        if (rootProjectOrder !== undefined) {
          group.rootProjectOrder = rootProjectOrder
        }
      }
    }
    if (updates.name !== undefined) {
      group.name = normalizeProjectGroupName(updates.name, group.name)
    }
    if (updates.isCollapsed !== undefined) {
      group.isCollapsed = updates.isCollapsed
    }
    if (updates.tabOrder !== undefined && Number.isFinite(updates.tabOrder)) {
      group.tabOrder = updates.tabOrder
    }
    if (updates.rootProjectOrder === null) {
      delete group.rootProjectOrder
    } else if (
      updates.rootProjectOrder !== undefined &&
      Number.isFinite(updates.rootProjectOrder)
    ) {
      group.rootProjectOrder = updates.rootProjectOrder
    }
    if (updates.color !== undefined) {
      group.color = typeof updates.color === 'string' ? updates.color : null
    }
    if (updates.hookSettings !== undefined) {
      group.hookSettings = updates.hookSettings
    }
    if (updates.remoteMembers !== undefined) {
      const remoteMembers = normalizeProjectGroupRemoteMembers(updates.remoteMembers)
      if (remoteMembers.length > 0) {
        group.remoteMembers = remoteMembers
      } else {
        delete group.remoteMembers
      }
    }
    group.updatedAt = Date.now()
  }

  deleteProjectGroup(groupId: string): boolean {
    const before = this.state.projectGroups?.length ?? 0
    const deletedGroupIds = getProjectGroupSubtreeIds(this.state.projectGroups ?? [], groupId)
    this.state.projectGroups = (this.state.projectGroups ?? []).filter(
      (group) => !deletedGroupIds.has(group.id)
    )
    if ((this.state.projectGroups?.length ?? 0) === before) {
      return false
    }
    // Sidebar grouping does not own repos; ungroup them rather than delete them.
    this.state.repos = this.state.repos.map((repo) =>
      repo.projectGroupId && deletedGroupIds.has(repo.projectGroupId)
        ? { ...repo, projectGroupId: null }
        : repo
    )
    const removedFolderWorkspaceKeys = new Set<string>()
    for (const workspace of this.state.folderWorkspaces ?? []) {
      if (deletedGroupIds.has(workspace.projectGroupId)) {
        removedFolderWorkspaceKeys.add(folderWorkspaceKey(workspace.id))
        this.removeWorkspaceLineageForRemovedFolder(workspace.id)
      }
    }
    // Remove all partition copies or folder layouts could resurrect on load.
    removeWorkspaceSessionOwnersEverywhere(this.state, removedFolderWorkspaceKeys)
    this.state.folderWorkspaces = (this.state.folderWorkspaces ?? []).filter(
      (workspace) => !deletedGroupIds.has(workspace.projectGroupId)
    )
    this.pruneMobileClientTabSelections((worktreeId) => removedFolderWorkspaceKeys.has(worktreeId))
    this.scheduleSave([
      'projectGroups',
      'repos',
      'folderWorkspaces',
      'workspaceLineageByChildKey',
      'crossStoreLineageByChildKey',
      ...WORKSPACE_SESSION_DOMAINS,
      'mobileClientTabSelectionsByDeviceId'
    ])
    return true
  }
}
