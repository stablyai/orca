import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import {
  resolveFolderWorkspaceCatalogOwnerHostId,
  resolveFolderWorkspaceProjectGroupWithLegacySsh
} from '../../../shared/folder-workspaces'
import {
  buildProjectGroupOwnerIndex,
  createProjectGroup,
  getProjectGroupOwnerIdentity,
  getProjectGroupOwnerSubtreeIdentities,
  normalizeProjectGroupName,
  resolveProjectGroupMembership,
  resolveProjectGroupOwner
} from '../../../shared/project-groups'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { StoreOwnedPersistedState } from '../loading-store/store-owned-state'

export type ProjectGroupMutationOperations = {
  state: StoreOwnedPersistedState
  scheduleSave: () => void
  removeWorkspaceLineageForFolderParent: (
    folderWorkspaceId: string,
    ownerHostId?: ExecutionHostId | null,
    removeBareKey?: boolean
  ) => void
  removeWorkspaceSessionStateForWorktree: (
    worktreeId: string,
    ownerHostId?: ExecutionHostId | null
  ) => void
  pruneMobileClientTabSelections: (matchesWorktreeId: (worktreeId: string) => boolean) => void
}

export class ProjectGroupPersistenceOperations {
  constructor(private readonly operations: ProjectGroupMutationOperations) {}

  private get state(): PersistedState {
    return this.operations.state
  }

  private scheduleSave(): void {
    this.operations.scheduleSave()
  }

  private removeWorkspaceLineageForFolderParent(
    folderWorkspaceId: string,
    ownerHostId?: ExecutionHostId | null,
    removeBareKey?: boolean
  ): void {
    this.operations.removeWorkspaceLineageForFolderParent(
      folderWorkspaceId,
      ownerHostId,
      removeBareKey
    )
  }

  private pruneMobileClientTabSelections(matchesWorktreeId: (worktreeId: string) => boolean): void {
    this.operations.pruneMobileClientTabSelections(matchesWorktreeId)
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
    // Why: persisted group lists can be large enough to exceed spread limits.
    for (const existingGroup of this.state.projectGroups ?? []) {
      maxOrder = Math.max(maxOrder, existingGroup.tabOrder)
    }
    const group = createProjectGroup({
      ...input,
      tabOrder: maxOrder + 1
    })
    this.state.projectGroups = [...(this.state.projectGroups ?? []), group]
    this.scheduleSave()
    return group
  }

  updateProjectGroup(
    groupId: string,
    updates: Partial<Pick<ProjectGroup, 'name' | 'isCollapsed' | 'tabOrder' | 'color'>>,
    ownerHostId?: ExecutionHostId
  ): ProjectGroup | null {
    const projectGroups = this.state.projectGroups ?? []
    const group = resolveProjectGroupOwner(
      buildProjectGroupOwnerIndex(projectGroups),
      groupId,
      ownerHostId
    )
    if (!group) {
      return null
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
    if (updates.color !== undefined) {
      group.color = typeof updates.color === 'string' ? updates.color : null
    }
    group.updatedAt = Date.now()
    this.scheduleSave()
    return group
  }

  deleteProjectGroup(groupId: string, ownerHostId?: ExecutionHostId): boolean {
    const projectGroups = this.state.projectGroups ?? []
    const projectGroupIndex = buildProjectGroupOwnerIndex(projectGroups)
    const rootGroup = resolveProjectGroupOwner(projectGroupIndex, groupId, ownerHostId)
    if (!rootGroup) {
      return false
    }
    const before = this.state.projectGroups?.length ?? 0
    const deletedGroupIdentities = getProjectGroupOwnerSubtreeIdentities(projectGroups, rootGroup)
    this.state.projectGroups = projectGroups.filter(
      (group) => !deletedGroupIdentities.has(getProjectGroupOwnerIdentity(group))
    )
    if ((this.state.projectGroups?.length ?? 0) === before) {
      return false
    }
    // Why: groups are sidebar organization only, so deleting one ungroups its repos rather than deleting them.
    this.state.repos = this.state.repos.map((repo) => {
      if (!repo.projectGroupId) {
        return repo
      }
      const group = resolveProjectGroupMembership(
        projectGroupIndex,
        repo.projectGroupId,
        getRepoExecutionHostId(repo)
      )
      return group && deletedGroupIdentities.has(getProjectGroupOwnerIdentity(group))
        ? { ...repo, projectGroupId: null }
        : repo
    })
    const folderWorkspaces = this.state.folderWorkspaces ?? []
    const removedFolderWorkspaces = folderWorkspaces.filter((workspace) => {
      const group = resolveFolderWorkspaceProjectGroupWithLegacySsh(projectGroupIndex, workspace)
      return group && deletedGroupIdentities.has(getProjectGroupOwnerIdentity(group))
    })
    const removedFolderWorkspaceSet = new Set(removedFolderWorkspaces)
    this.state.folderWorkspaces = folderWorkspaces.filter(
      (workspace) => !removedFolderWorkspaceSet.has(workspace)
    )
    const remainingFolderWorkspaceIds = new Set(
      this.state.folderWorkspaces.map((workspace) => workspace.id)
    )
    const removedFolderWorkspaceKeys = new Set<string>()
    for (const workspace of removedFolderWorkspaces) {
      const workspaceOwnerHostId = resolveFolderWorkspaceCatalogOwnerHostId(
        workspace,
        projectGroups
      )
      const workspaceKeys: string[] = []
      if (workspaceOwnerHostId) {
        workspaceKeys.push(folderWorkspaceKey(workspace.id, workspaceOwnerHostId))
      }
      const removeBareKey = !remainingFolderWorkspaceIds.has(workspace.id)
      if (removeBareKey) {
        workspaceKeys.push(folderWorkspaceKey(workspace.id))
      }
      for (const key of workspaceKeys) {
        removedFolderWorkspaceKeys.add(key)
        this.operations.removeWorkspaceSessionStateForWorktree(key, workspaceOwnerHostId)
      }
      this.removeWorkspaceLineageForFolderParent(workspace.id, workspaceOwnerHostId, removeBareKey)
    }
    this.pruneMobileClientTabSelections((worktreeId) => removedFolderWorkspaceKeys.has(worktreeId))
    this.scheduleSave()
    return true
  }
}
