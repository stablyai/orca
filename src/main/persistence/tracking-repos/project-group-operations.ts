import { getRepoExecutionHostId } from '../../../shared/execution-host'
import type { ProfileSaveDomains } from '../profile-save-domains'
import { WORKSPACE_SESSION_DOMAINS } from '../workspace-session-domains'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  ProjectGroup,
  ProjectGroupMutation,
  ProjectGroupUpdate
} from '../../../shared/project-group-types'
import {
  createProjectGroup,
  getNextProjectGroupOrder,
  getProjectGroupSubtreeIds,
  normalizeProjectGroupName
} from '../../../shared/project-groups'
import { getNextRootProjectOrder } from '../../../shared/root-project-order'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
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
    const normalizedParentGroupId = input.parentGroupId?.trim() || null
    const parentGroup =
      normalizedParentGroupId !== null
        ? (this.state.projectGroups ?? []).find((entry) => entry.id === normalizedParentGroupId)
        : undefined
    if (normalizedParentGroupId !== null && !parentGroup) {
      throw new Error('project_group_parent_not_found')
    }
    if (
      parentGroup &&
      input.connectionId !== undefined &&
      input.connectionId !== null &&
      (parentGroup.connectionId ?? null) !== input.connectionId
    ) {
      throw new Error('project_group_parent_host_mismatch')
    }
    let maxOrder = -1
    // Large persisted lists can exceed spread argument limits.
    for (const existingGroup of this.state.projectGroups ?? []) {
      maxOrder = Math.max(maxOrder, existingGroup.tabOrder)
    }
    if (normalizedParentGroupId) {
      maxOrder = Math.max(
        maxOrder,
        getNextProjectGroupOrder(
          this.state.repos,
          normalizedParentGroupId,
          this.state.projectGroups
        ) - 1
      )
    }
    const group = createProjectGroup({
      ...input,
      connectionId: input.connectionId ?? parentGroup?.connectionId ?? null,
      parentGroupId: normalizedParentGroupId,
      tabOrder: maxOrder + 1
    })
    if (parentGroup?.executionHostId) {
      group.executionHostId = parentGroup.executionHostId
    }
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
    const allGroups = this.state.projectGroups ?? []
    const group = allGroups.find((entry) => entry.id === groupId)
    if (!group) {
      return null
    }
    const parentResult = this.resolveValidatedParentGroupId(allGroups, groupId, updates)
    if (!parentResult.ok) {
      return null
    }
    this.applyGroupUpdate(group, updates, parentResult.parentGroupId)
    this.scheduleSave(['projectGroups'])
    return group
  }

  updateProjectGroups(mutations: readonly ProjectGroupMutation[]): ProjectGroup[] | null {
    const allGroups = this.state.projectGroups ?? []
    const byId = new Map(allGroups.map((group) => [group.id, group]))
    if (mutations.some(({ groupId }) => !byId.has(groupId))) {
      return null
    }
    const simulatedGroups = allGroups.map((group) => ({ ...group }))
    const simulatedById = new Map(simulatedGroups.map((group) => [group.id, group]))
    const normalizedParents: (string | null | undefined)[] = []
    for (const { groupId, updates } of mutations) {
      const parentResult = this.resolveValidatedParentGroupId(simulatedGroups, groupId, updates)
      if (!parentResult.ok) {
        return null
      }
      if (parentResult.parentGroupId !== undefined) {
        simulatedById.get(groupId)!.parentGroupId = parentResult.parentGroupId
      }
      normalizedParents.push(parentResult.parentGroupId)
    }
    const updated = mutations.map(({ groupId, updates }, index) => {
      const group = byId.get(groupId)!
      this.applyGroupUpdate(group, updates, normalizedParents[index])
      return group
    })
    if (updated.length > 0) {
      this.scheduleSave(['projectGroups'])
    }
    return updated
  }

  private resolveValidatedParentGroupId(
    allGroups: readonly ProjectGroup[],
    groupId: string,
    updates: ProjectGroupUpdate
  ): { ok: true; parentGroupId: string | null | undefined } | { ok: false } {
    if (updates.parentGroupId === undefined) {
      return { ok: true, parentGroupId: undefined }
    }
    const normalizedParentGroupId = updates.parentGroupId?.trim() || null
    if (normalizedParentGroupId !== null) {
      const movingGroup = allGroups.find((entry) => entry.id === groupId)
      const parentGroup = allGroups.find((entry) => entry.id === normalizedParentGroupId)
      if (
        !movingGroup ||
        !parentGroup ||
        getRepoExecutionHostId(movingGroup) !== getRepoExecutionHostId(parentGroup) ||
        getProjectGroupSubtreeIds(allGroups, groupId).has(normalizedParentGroupId)
      ) {
        return { ok: false }
      }
    }
    return { ok: true, parentGroupId: normalizedParentGroupId }
  }

  private applyGroupUpdate(
    group: ProjectGroup,
    updates: ProjectGroupUpdate,
    normalizedParentGroupId: string | null | undefined
  ): void {
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
    if (normalizedParentGroupId !== undefined) {
      if (
        normalizedParentGroupId !== (group.parentGroupId ?? null) &&
        updates.isPinned === undefined
      ) {
        group.isPinned = false
      }
      if (normalizedParentGroupId !== null && updates.rootProjectOrder === undefined) {
        delete group.rootProjectOrder
      }
      group.parentGroupId = normalizedParentGroupId
    }
    if (typeof updates.isPinned === 'boolean') {
      group.isPinned = updates.isPinned
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
        ? { ...repo, projectGroupId: null, isPinned: false }
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
