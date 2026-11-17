import type { ProfileSaveDomains } from '../profile-save-domains'
import { WORKSPACE_SESSION_DOMAINS } from '../workspace-session-domains'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import type {
  ProjectGroup,
  ProjectGroupMutation,
  ProjectGroupUpdate
} from '../../../shared/project/groups/project-group-types'
import {
  createProjectGroup,
  getProjectGroupSubtreeIds,
  normalizeProjectGroupName
} from '../../../shared/project/groups/project-groups'
import {
  canCreateProjectSubgroup,
  describeProjectGroupMoveRejection,
  getProjectGroupMoveRejection,
  type ProjectGroupNestingNode
} from '../../../shared/project/groups/project-group-nesting'
import { getNextRootProjectOrder } from '../../../shared/sidebar-list/sections/root-project-order'
import { folderWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { removeWorkspaceSessionOwnersEverywhere } from '../restoring-sessions/session-owner-removal'

export type ProjectGroupMutationOperations = {
  state: PersistedState
  scheduleSave: (domains: ProfileSaveDomains) => void
  removeWorkspaceLineageForRemovedFolder: (folderWorkspaceId: string) => void
  pruneMobileClientTabSelections: (matchesWorktreeId: (worktreeId: string) => boolean) => void
}

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
    const rootProjectOrder = !group.parentGroupId
      ? getNextRootProjectOrder(this.state.repos, groups)
      : undefined
    if (rootProjectOrder !== undefined) {
      group.rootProjectOrder = rootProjectOrder
    }
    this.state.projectGroups = [...groups, group]
    this.scheduleSave(['projectGroups'])
    return group
  }

  private nextProjectGroupTabOrder(): number {
    let maxOrder = -1
    // Large persisted lists can exceed spread argument limits.
    for (const existingGroup of this.state.projectGroups ?? []) {
      maxOrder = Math.max(maxOrder, existingGroup.tabOrder)
    }
    return maxOrder + 1
  }

  updateProjectGroup(groupId: string, updates: ProjectGroupUpdate): ProjectGroup | null {
    const group = (this.state.projectGroups ?? []).find((entry) => entry.id === groupId)
    if (!group) {
      return null
    }
    this.assertProjectGroupMovesAllowed([{ groupId, updates }])
    this.applyGroupUpdate(group, updates)
    this.scheduleSave(['projectGroups'])
    return group
  }

  updateProjectGroups(mutations: readonly ProjectGroupMutation[]): ProjectGroup[] | null {
    const byId = new Map((this.state.projectGroups ?? []).map((group) => [group.id, group]))
    if (mutations.some(({ groupId }) => !byId.has(groupId))) {
      return null
    }
    this.assertProjectGroupMovesAllowed(mutations)
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

  // Why: every move is checked, in order, before any applies, so a rejected batch changes nothing.
  private assertProjectGroupMovesAllowed(mutations: readonly ProjectGroupMutation[]): void {
    let groups: readonly ProjectGroupNestingNode[] = this.state.projectGroups ?? []
    for (const { groupId, updates } of mutations) {
      if (updates.parentGroupId === undefined) {
        continue
      }
      const parentGroupId = updates.parentGroupId ?? null
      const group = groups.find((entry) => entry.id === groupId)
      // Why: only a real move is validated, so renaming a group in a deep imported tree still works.
      if (!group || (group.parentGroupId ?? null) === parentGroupId) {
        continue
      }
      const rejection = getProjectGroupMoveRejection(groups, groupId, parentGroupId)
      if (rejection) {
        throw new Error(describeProjectGroupMoveRejection(rejection))
      }
      groups = groups.map((entry) => (entry.id === groupId ? { ...entry, parentGroupId } : entry))
    }
  }

  private applyGroupUpdate(group: ProjectGroup, updates: ProjectGroupUpdate): void {
    const parentGroupId = updates.parentGroupId ?? null
    if (updates.parentGroupId !== undefined && parentGroupId !== (group.parentGroupId ?? null)) {
      this.placeMovedGroup(group, parentGroupId)
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
    group.updatedAt = Date.now()
  }

  /** Lands a moved group last among its new siblings; explicit orders in the same update win. */
  private placeMovedGroup(group: ProjectGroup, parentGroupId: string | null): void {
    group.parentGroupId = parentGroupId
    group.tabOrder = this.nextProjectGroupTabOrder()
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
