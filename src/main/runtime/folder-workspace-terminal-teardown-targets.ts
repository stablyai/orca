import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import {
  resolveDeclaredFolderScopeOwner,
  resolveDirectFolderScopeAuthority,
  resolveFolderWorkspaceOwner,
  resolveProjectGroupOwner
} from '../../shared/folder-workspace-owner-resolution'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../shared/types'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import {
  inferFolderWorkspacePathConnection,
  type FolderWorkspacePathConnectionResolution
} from '../project-groups/folder-workspace-path-status'

export type FolderWorkspaceTerminalTeardownTarget = {
  workspaceKey: string
  connection: FolderWorkspacePathConnectionResolution
}

function resolveFolderWorkspaceProjectGroup(
  workspace: FolderWorkspace,
  groupsById: ReadonlyMap<string, readonly ProjectGroup[]>,
  workspaceHostId: ExecutionHostId | null
): ProjectGroup | undefined {
  const candidates = groupsById.get(workspace.projectGroupId) ?? []
  if (!workspaceHostId) {
    return undefined
  }
  const matching = candidates.filter((group) => {
    const owner = resolveProjectGroupOwner(group)
    return owner.status === 'owned' && owner.executionHostId === workspaceHostId
  })
  return matching.length === 1 ? matching[0] : candidates.length === 1 ? candidates[0] : undefined
}

export function resolveFolderWorkspaceTerminalTeardownTargets(args: {
  workspaces: readonly FolderWorkspace[]
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}): FolderWorkspaceTerminalTeardownTarget[] {
  const groupsById = new Map<string, ProjectGroup[]>()
  for (const group of args.projectGroups) {
    const matching = groupsById.get(group.id) ?? []
    matching.push(group)
    groupsById.set(group.id, matching)
  }
  const targets = new Map<string, FolderWorkspaceTerminalTeardownTarget>()
  for (const workspace of args.workspaces) {
    const workspaceOwner = resolveFolderWorkspaceOwner(workspace, args.projectGroups)
    const workspaceHostId =
      workspaceOwner.status === 'owned' ? workspaceOwner.executionHostId : null
    const group = resolveFolderWorkspaceProjectGroup(workspace, groupsById, workspaceHostId)
    const hasHostCollidingGroup = (groupsById.get(workspace.projectGroupId)?.length ?? 0) > 1
    const projectGroups = hasHostCollidingGroup
      ? args.projectGroups.filter((candidate) => {
          const owner = resolveProjectGroupOwner(candidate)
          return owner.status === 'owned' && owner.executionHostId === workspaceHostId
        })
      : args.projectGroups
    const repos = hasHostCollidingGroup
      ? args.repos.filter((repo) => getRepoExecutionHostId(repo) === workspaceHostId)
      : args.repos
    const workspaceKey = folderWorkspaceKey(workspace.id)
    const workspaceConnectionIdIsAuthoritative = workspace.connectionId !== undefined
    const groupConnectionIdIsAuthoritative = group?.connectionId !== undefined
    const connectionId = workspaceConnectionIdIsAuthoritative
      ? workspace.connectionId
      : (group?.connectionId ?? null)
    const workspaceDeclaredOwner = resolveDeclaredFolderScopeOwner(workspace)
    const directAuthority = resolveDirectFolderScopeAuthority(
      workspaceDeclaredOwner.status === 'unknown' && group ? group : workspace
    )
    const connection: FolderWorkspacePathConnectionResolution =
      workspaceOwner.status === 'invalid' || directAuthority.status === 'invalid'
        ? { kind: 'ambiguous' }
        : directAuthority.status === 'direct'
          ? directAuthority.connectionId
            ? { kind: 'ssh', connectionId: directAuthority.connectionId }
            : { kind: 'local' }
          : inferFolderWorkspacePathConnection({
              folderPath: workspace.folderPath,
              projectGroupId: workspace.projectGroupId,
              connectionId,
              connectionIdIsAuthoritative:
                workspaceConnectionIdIsAuthoritative || groupConnectionIdIsAuthoritative,
              projectGroups,
              repos
            })
    const connectionIdentity =
      connection.kind === 'ssh' ? `ssh:${connection.connectionId}` : connection.kind
    targets.set(`${workspaceKey}\0${connectionIdentity}`, { workspaceKey, connection })
  }
  return [...targets.values()]
}
