import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../../shared/folder-workspace-path-status'
import {
  assertFolderWorkspacePathUsable,
  getFolderWorkspacePathStatus,
  getFolderWorkspacePathStatusForPath
} from '../project-groups/folder-workspace-path-status'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import type { RuntimeStore } from './runtime-store-contract'
import { folderWorkspaceKey } from '../../shared/workspace-scope'

type RuntimeProjectGroupDependencies = {
  getStore: () => RuntimeStore | null
  resolveRepo: (selector: string) => Promise<Repo>
  notifyReposChanged: () => void
  resolveFolderConnectionId: (workspace: FolderWorkspace) => string | null
  teardownFolderWorkspacePtys: (worktreeId: string, connectionId: string | null) => Promise<void>
  cleanupRemovedFolderWorkspaceState: (worktreeId: string) => void
}

type FolderWorkspaceUpdates = Partial<
  Pick<
    FolderWorkspace,
    | 'name'
    | 'folderPath'
    | 'linkedTask'
    | 'linkedTaskSourceContext'
    | 'comment'
    | 'isArchived'
    | 'isUnread'
    | 'isPinned'
    | 'sortOrder'
    | 'manualOrder'
    | 'workspaceStatus'
    | 'createdWithAgent'
    | 'pendingFirstAgentMessageRename'
    | 'firstAgentMessageRenameError'
    | 'lastActivityAt'
    | 'diffComments'
  >
>

export class RuntimeProjectGroupController {
  constructor(private readonly deps: RuntimeProjectGroupDependencies) {}

  listGroups(): ProjectGroup[] {
    return this.deps.getStore()?.getProjectGroups?.() ?? []
  }

  listFolderWorkspaces(): FolderWorkspace[] {
    return this.deps.getStore()?.getFolderWorkspaces?.() ?? []
  }

  async createGroup(input: {
    name: string
    parentPath?: string | null
    connectionId?: string | null
    parentGroupId?: string | null
    createdFrom?: ProjectGroup['createdFrom']
  }): Promise<ProjectGroup> {
    const store = this.deps.getStore()
    if (!store?.createProjectGroup) {
      throw new Error('runtime_unavailable')
    }
    const group = store.createProjectGroup({
      name: input.name,
      parentPath: input.parentPath ?? null,
      connectionId: input.connectionId ?? null,
      parentGroupId: input.parentGroupId ?? null,
      createdFrom: input.createdFrom ?? 'manual'
    })
    this.deps.notifyReposChanged()
    return group
  }

  async updateGroup(
    groupId: string,
    updates: Partial<Pick<ProjectGroup, 'name' | 'isCollapsed' | 'tabOrder' | 'color'>>
  ): Promise<ProjectGroup | null> {
    const store = this.deps.getStore()
    if (!store?.updateProjectGroup) {
      throw new Error('runtime_unavailable')
    }
    const updated = store.updateProjectGroup(groupId, updates)
    if (updated) {
      this.deps.notifyReposChanged()
    }
    return updated
  }

  async deleteGroup(groupId: string): Promise<{ deleted: boolean }> {
    const store = this.deps.getStore()
    if (!store?.deleteProjectGroup) {
      throw new Error('runtime_unavailable')
    }
    const deleted = store.deleteProjectGroup(groupId)
    if (deleted) {
      this.deps.notifyReposChanged()
    }
    return { deleted }
  }

  async moveProject(repoSelector: string, groupId: string | null, order?: number): Promise<Repo> {
    const store = this.deps.getStore()
    if (!store?.moveProjectToGroup) {
      throw new Error('runtime_unavailable')
    }
    const repo = await this.deps.resolveRepo(repoSelector)
    const moved = store.moveProjectToGroup(repo.id, groupId, order)
    if (!moved) {
      throw new Error('repo_not_found')
    }
    this.deps.notifyReposChanged()
    return moved
  }

  async createFolderWorkspace(input: {
    projectGroupId: string
    name?: string
    folderPath?: string | null
    connectionId?: string | null
    creatorProvenance?: FolderWorkspace['creatorProvenance']
    linkedTask?: FolderWorkspace['linkedTask']
    linkedTaskSourceContext?: FolderWorkspace['linkedTaskSourceContext']
    createdWithAgent?: FolderWorkspace['createdWithAgent']
    pendingFirstAgentMessageRename?: boolean
  }): Promise<FolderWorkspace> {
    const store = this.deps.getStore()
    if (!store?.createFolderWorkspace) {
      throw new Error('runtime_unavailable')
    }
    const projectGroups = store.getProjectGroups?.() ?? []
    const group = projectGroups.find((entry) => entry.id === input.projectGroupId)
    const folderPath =
      typeof input.folderPath === 'string' && input.folderPath.trim().length > 0
        ? input.folderPath
        : group?.parentPath
    if (!group || !folderPath) {
      throw new Error('folder_workspace_project_group_not_found')
    }
    const status = await getFolderWorkspacePathStatusForPath(
      {
        folderPath,
        projectGroupId: group.id,
        connectionId: input.connectionId ?? group.connectionId ?? null,
        projectGroups,
        repos: store.getRepos()
      },
      { getSshFilesystemProvider }
    )
    assertFolderWorkspacePathUsable(status)
    const workspace = store.createFolderWorkspace({
      ...input,
      creatorProvenance: input.creatorProvenance ?? { kind: 'host' }
    })
    this.deps.notifyReposChanged()
    return workspace
  }

  async getFolderPathStatus(
    request: FolderWorkspacePathStatusRequest
  ): Promise<FolderWorkspacePathStatus> {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    return getFolderWorkspacePathStatus(store, request, { getSshFilesystemProvider })
  }

  async updateFolderWorkspace(
    folderWorkspaceId: string,
    updates: FolderWorkspaceUpdates
  ): Promise<FolderWorkspace | null> {
    const store = this.deps.getStore()
    if (!store?.updateFolderWorkspace) {
      throw new Error('runtime_unavailable')
    }
    if (typeof updates.folderPath === 'string' && updates.folderPath.trim().length > 0) {
      const workspace = store
        .getFolderWorkspaces?.()
        .find((entry) => entry.id === folderWorkspaceId)
      if (!workspace) {
        return null
      }
      const projectGroups = store.getProjectGroups?.() ?? []
      const status = await getFolderWorkspacePathStatusForPath(
        {
          folderPath: updates.folderPath,
          projectGroupId: workspace.projectGroupId,
          connectionId:
            workspace.connectionId ??
            projectGroups.find((entry) => entry.id === workspace.projectGroupId)?.connectionId ??
            null,
          projectGroups,
          repos: store.getRepos()
        },
        { getSshFilesystemProvider }
      )
      assertFolderWorkspacePathUsable(status)
    }
    const updated = store.updateFolderWorkspace(folderWorkspaceId, updates)
    if (updated) {
      this.deps.notifyReposChanged()
    }
    return updated
  }

  async deleteFolderWorkspace(folderWorkspaceId: string): Promise<{ deleted: boolean }> {
    const store = this.deps.getStore()
    if (!store?.removeFolderWorkspace) {
      throw new Error('runtime_unavailable')
    }
    const workspace = store.getFolderWorkspaces?.().find((entry) => entry.id === folderWorkspaceId)
    if (workspace) {
      const worktreeId = folderWorkspaceKey(folderWorkspaceId)
      // Why: a mixed-host group has no single PTY target; forgetting the
      // workspace must still succeed, so skip the sweep instead of failing.
      let connectionId: string | null | undefined
      try {
        connectionId = this.deps.resolveFolderConnectionId(workspace)
      } catch (error) {
        console.warn(`[folder-workspace] skipping PTY teardown for ${worktreeId}:`, error)
      }
      if (connectionId !== undefined) {
        await this.deps.teardownFolderWorkspacePtys(worktreeId, connectionId)
      }
      this.deps.cleanupRemovedFolderWorkspaceState(worktreeId)
    }
    const deleted = store.removeFolderWorkspace(folderWorkspaceId)
    if (deleted) {
      this.deps.notifyReposChanged()
    }
    return { deleted }
  }
}
