import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import { isPathInsideOrEqual } from '../../../shared/cross-platform-path'
import { getRepoExecutionHostId, normalizeExecutionHostId } from '../../../shared/execution-host'
import {
  buildProjectGroupOwnerIndex,
  getProjectGroupOwnerIdentity,
  getProjectGroupOwnerSubtreeIdentities,
  resolveProjectGroupMembership,
  resolveProjectGroupOwner,
  type ProjectGroupOwnerIndex
} from '../../../shared/project-groups'

export function inferFolderScopeConnectionIdForMigration(args: {
  folderPath: string
  projectGroup: ProjectGroup
  projectGroups: readonly ProjectGroup[]
  projectGroupIndex: ProjectGroupOwnerIndex
  repos: readonly Repo[]
}): string | null {
  if (args.projectGroupIndex.byId.get(args.projectGroup.id)?.length !== 1) {
    return null
  }
  const groupIdentities = getProjectGroupOwnerSubtreeIdentities(
    args.projectGroups,
    args.projectGroup
  )
  const groupRepos = args.repos.filter(
    (repo) =>
      typeof repo.projectGroupId === 'string' &&
      (() => {
        const exactGroup = resolveProjectGroupMembership(
          args.projectGroupIndex,
          repo.projectGroupId,
          getRepoExecutionHostId(repo)
        )
        const group =
          exactGroup ?? resolveProjectGroupOwner(args.projectGroupIndex, repo.projectGroupId)
        return group !== null && groupIdentities.has(getProjectGroupOwnerIdentity(group))
      })()
  )
  const candidateRepos =
    groupRepos.length > 0
      ? groupRepos
      : args.repos.filter((repo) => isPathInsideOrEqual(args.folderPath, repo.path))
  if (candidateRepos.length === 0) {
    return null
  }
  let hasLocalRepo = false
  const connectionIds = new Set<string>()
  for (const repo of candidateRepos) {
    if (repo.connectionId) {
      connectionIds.add(repo.connectionId)
    } else {
      hasLocalRepo = true
    }
  }
  if (hasLocalRepo || connectionIds.size !== 1) {
    return null
  }
  return [...connectionIds][0]
}

export function backfillFolderScopeConnectionIds(state: PersistedState): {
  state: PersistedState
  changed: boolean
} {
  const groups = state.projectGroups ?? []
  const repos = state.repos ?? []
  const originalProjectGroupIndex = buildProjectGroupOwnerIndex(groups)
  let changed = false
  const projectGroups = groups.map((group) => {
    if (
      group.connectionId !== undefined ||
      normalizeExecutionHostId(group.executionHostId) ||
      !group.parentPath
    ) {
      return group
    }
    const connectionId = inferFolderScopeConnectionIdForMigration({
      folderPath: group.parentPath,
      projectGroup: group,
      projectGroups: groups,
      projectGroupIndex: originalProjectGroupIndex,
      repos
    })
    if (!connectionId) {
      return group
    }
    changed = true
    return { ...group, connectionId }
  })
  const projectGroupIndex = buildProjectGroupOwnerIndex(projectGroups)
  const folderWorkspaces = (state.folderWorkspaces ?? []).map((workspace) => {
    if (
      workspace.connectionId !== undefined ||
      normalizeExecutionHostId(workspace.executionHostId)
    ) {
      return workspace
    }
    const group = resolveProjectGroupOwner(projectGroupIndex, workspace.projectGroupId)
    const groupConnectionId = group?.connectionId ?? null
    const connectionId =
      groupConnectionId ??
      (group
        ? inferFolderScopeConnectionIdForMigration({
            folderPath: workspace.folderPath,
            projectGroup: group,
            projectGroups,
            projectGroupIndex,
            repos
          })
        : null)
    if (!connectionId) {
      return workspace
    }
    changed = true
    return { ...workspace, connectionId }
  })
  return {
    changed,
    state: changed ? { ...state, projectGroups, folderWorkspaces } : state
  }
}
