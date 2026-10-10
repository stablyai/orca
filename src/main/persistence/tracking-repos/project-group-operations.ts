import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ProjectGroup, ProjectGroupUpdates } from '../../../shared/project-group-types'
import {
  createProjectGroup,
  getProjectGroupSubtreeIds,
  normalizeProjectGroupName
} from '../../../shared/project-groups'
import {
  canCreateProjectSubgroup,
  describeProjectGroupMoveRejection,
  getProjectGroupMoveRejection
} from '../../../shared/project-group-nesting'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { removeWorkspaceSessionOwnersEverywhere } from '../restoring-sessions/session-owner-removal'

export type ProjectGroupMutationOperations = {
  state: PersistedState
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
    const groups = this.state.projectGroups ?? []
    let connectionId = input.connectionId
    // Why: folder imports may nest deeper than the cap, so only hand-made subgroups are checked.
    if (input.createdFrom === 'manual' && input.parentGroupId != null) {
      const parent = groups.find((entry) => entry.id === input.parentGroupId)
      if (!parent) {
        throw new Error(describeProjectGroupMoveRejection('parent-not-found'))
      }
      if (!canCreateProjectSubgroup(groups, parent.id)) {
        throw new Error(describeProjectGroupMoveRejection('too-deep'))
      }
      // Why: a manual subgroup lives on its parent's host, like folder-scan children; null means unspecified.
      const parentConnectionId = parent.connectionId ?? null
      if (input.connectionId && input.connectionId !== parentConnectionId) {
        throw new Error(describeProjectGroupMoveRejection('host-mismatch'))
      }
      connectionId = parentConnectionId
    }
    const group = createProjectGroup({
      ...input,
      connectionId,
      tabOrder: this.nextProjectGroupTabOrder()
    })
    this.state.projectGroups = [...groups, group]
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
    const parentGroupId = updates.parentGroupId ?? null
    // Why: only a real move is validated, so renaming a group in a deep imported tree still works.
    const movesGroup =
      updates.parentGroupId !== undefined && parentGroupId !== (group.parentGroupId ?? null)
    if (movesGroup) {
      const rejection = getProjectGroupMoveRejection(groups, groupId, parentGroupId)
      if (rejection) {
        throw new Error(describeProjectGroupMoveRejection(rejection))
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
    if (updates.color !== undefined) {
      group.color = typeof updates.color === 'string' ? updates.color : null
    }
    if (movesGroup) {
      group.parentGroupId = parentGroupId
      if (updates.tabOrder === undefined) {
        // Why: a moved group lands last among its new siblings, like a newly created one.
        group.tabOrder = this.nextProjectGroupTabOrder()
      }
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
        this.removeWorkspaceLineageForFolderParent(workspace.id)
      }
    }
    // Every partition, not just the local blob: the same reason `removeFolderWorkspace` does.
    removeWorkspaceSessionOwnersEverywhere(this.state, removedFolderWorkspaceKeys)
    this.state.folderWorkspaces = (this.state.folderWorkspaces ?? []).filter(
      (workspace) => !deletedGroupIds.has(workspace.projectGroupId)
    )
    this.pruneMobileClientTabSelections((worktreeId) => removedFolderWorkspaceKeys.has(worktreeId))
    this.scheduleSave()
    return true
  }
}
