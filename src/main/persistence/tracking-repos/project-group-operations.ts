import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ProjectGroup, ProjectGroupUpdates } from '../../../shared/project-group-types'
import {
  describeProjectGroupReparentRejection,
  getProjectGroupCreateChildRejection,
  getProjectGroupReparentRejection
} from '../../../shared/project-group-reparent'
import {
  createProjectGroup,
  getProjectGroupSubtreeIds,
  normalizeProjectGroupName
} from '../../../shared/project-groups'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { StoreOwnedPersistedState } from '../loading-store/store-owned-state'
import { removeWorkspaceSessionOwner } from '../restoring-sessions/session-owner-removal'

export type ProjectGroupMutationOperations = {
  state: StoreOwnedPersistedState
  scheduleSave: () => void
  removeWorkspaceLineageForFolderParent: (folderWorkspaceId: string) => void
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

  private removeWorkspaceLineageForFolderParent(folderWorkspaceId: string): void {
    this.operations.removeWorkspaceLineageForFolderParent(folderWorkspaceId)
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
    // Why: folder-scan imports mirror the on-disk tree and may legitimately exceed the manual nesting cap.
    if (input.parentGroupId && input.createdFrom === 'manual') {
      const rejection = getProjectGroupCreateChildRejection(
        this.state.projectGroups ?? [],
        input.parentGroupId
      )
      if (rejection) {
        throw new Error(describeProjectGroupReparentRejection(rejection))
      }
    }
    const group = createProjectGroup({
      ...input,
      tabOrder: this.nextProjectGroupTabOrder()
    })
    this.state.projectGroups = [...(this.state.projectGroups ?? []), group]
    this.scheduleSave()
    return group
  }

  private nextProjectGroupTabOrder(): number {
    let maxOrder = -1
    // Why: persisted group lists can be large enough to exceed spread limits.
    for (const existingGroup of this.state.projectGroups ?? []) {
      maxOrder = Math.max(maxOrder, existingGroup.tabOrder)
    }
    return maxOrder + 1
  }

  updateProjectGroup(groupId: string, updates: ProjectGroupUpdates): ProjectGroup | null {
    const groups = this.state.projectGroups ?? []
    const group = groups.find((entry) => entry.id === groupId)
    if (!group) {
      return null
    }
    if (updates.parentGroupId !== undefined) {
      const rejection = getProjectGroupReparentRejection(groups, groupId, updates.parentGroupId)
      if (rejection) {
        throw new Error(describeProjectGroupReparentRejection(rejection))
      }
      if (updates.parentGroupId !== group.parentGroupId && updates.tabOrder === undefined) {
        // Why: a re-parented group lands last among its new siblings, like a freshly created one.
        group.tabOrder = this.nextProjectGroupTabOrder()
      }
      group.parentGroupId = updates.parentGroupId
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

  deleteProjectGroup(groupId: string): boolean {
    const before = this.state.projectGroups?.length ?? 0
    const deletedGroupIds = getProjectGroupSubtreeIds(this.state.projectGroups ?? [], groupId)
    this.state.projectGroups = (this.state.projectGroups ?? []).filter(
      (group) => !deletedGroupIds.has(group.id)
    )
    if ((this.state.projectGroups?.length ?? 0) === before) {
      return false
    }
    // Why: groups are sidebar organization only, so deleting one ungroups its repos rather than deleting them.
    this.state.repos = this.state.repos.map((repo) =>
      repo.projectGroupId && deletedGroupIds.has(repo.projectGroupId)
        ? { ...repo, projectGroupId: null }
        : repo
    )
    const removedFolderWorkspaceKeys = new Set<string>()
    for (const workspace of this.state.folderWorkspaces ?? []) {
      if (deletedGroupIds.has(workspace.projectGroupId)) {
        removedFolderWorkspaceKeys.add(folderWorkspaceKey(workspace.id))
        this.state.workspaceSession = removeWorkspaceSessionOwner(
          this.state.workspaceSession,
          folderWorkspaceKey(workspace.id)
        )!
        this.removeWorkspaceLineageForFolderParent(workspace.id)
      }
    }
    this.state.folderWorkspaces = (this.state.folderWorkspaces ?? []).filter(
      (workspace) => !deletedGroupIds.has(workspace.projectGroupId)
    )
    this.pruneMobileClientTabSelections((worktreeId) => removedFolderWorkspaceKeys.has(worktreeId))
    this.scheduleSave()
    return true
  }
}
