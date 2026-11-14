import type {
  RuntimeProjectGroupDependencies,
  FolderWorkspaceUpdates
} from './runtime-project-group-contract'
export type { RuntimeProjectGroupDependencies } from './runtime-project-group-contract'
import { projectGroupHookOwner } from '../../../shared/workspace-hook-owner'
import { RuntimeRepositoryHooksCommands } from './runtime-repository-hooks-commands'
import { getEffectiveSetupRunPolicy } from '../../workspace-hooks/effective-hook-config'
import { getSetupConfig } from '../../../shared/orca-hook-setup-config'
import type { FolderWorkspaceCreateResult } from '../../../shared/folder-workspaces/folder-workspace-create'
import type { RuntimeGroupFolderCreateInput } from '../workspaces/creation/runtime-group-folder-setup'
import { refuseWslHostWindowsDrivePath } from '../terminal/launch/wsl-host-windows-drive-guard'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type {
  ProjectGroup,
  ProjectGroupMutation,
  ProjectGroupUpdate
} from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../../../shared/folder-workspaces/folder-workspace-path-status'
import {
  assertFolderWorkspacePathUsable,
  folderWorkspacePathRefusal,
  getFolderWorkspacePathStatus,
  getFolderWorkspacePathStatusForPath
} from '../../project-groups/folder-workspace-path-status'
import { FolderWorkspaceCreateRefusedError } from '../../project-groups/folder-workspace-create-refusal'
import {
  runtimeVisibleFolderWorkspaces,
  runtimeVisibleProjectGroups
} from '../workspaces/catalog/runtime-visible-catalog'
import {
  assertUniqueIdWhenRequired,
  type FolderWorkspaceMutationOptions
} from './folder-workspace-unique-id-mutation'
import { deleteFolderWorkspaceRow } from './folder-workspace-deletion'
import { createFolderWorkspaceWithPluginHooks } from '../../plugins/hooks/workspace-create-plugin-hook'
import {
  assertWslMoveRepoWritable,
  isLocalWslMoveRow,
  shouldDropWslMoveProjectUpdate
} from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'

export class RuntimeProjectGroupController {
  constructor(private readonly deps: RuntimeProjectGroupDependencies) {}

  listGroups(): ProjectGroup[] {
    return this.deps.getStore()?.getProjectGroups?.() ?? []
  }

  listFolderWorkspaces(): FolderWorkspace[] {
    return this.deps.getStore()?.getFolderWorkspaces?.() ?? []
  }

  /** What a client may list; `listGroups`/`listFolderWorkspaces` keep the full store. */
  listVisibleGroups(): ProjectGroup[] {
    return runtimeVisibleProjectGroups(this.deps.getStore())
  }

  listVisibleFolderWorkspaces(): FolderWorkspace[] {
    return runtimeVisibleFolderWorkspaces(this.deps.getStore())
  }

  async checkGroupHooks(groupId: string, options: { background?: boolean } = {}) {
    const group = this.listGroups().find((entry) => entry.id === groupId)
    const owner = group && projectGroupHookOwner(group)
    if (!owner) {
      throw new Error('folder_workspace_project_group_not_found')
    }
    const checked = await new RuntimeRepositoryHooksCommands({
      resolveRepo: async () => owner,
      readCreateSourceHooks: async () => undefined
    }).checkRepoHooks(groupId, options)
    return {
      ...checked,
      hookSettings: owner.hookSettings,
      setupRunPolicy: getEffectiveSetupRunPolicy(owner),
      setupConfig: getSetupConfig(owner, checked.hooks)
    }
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

  async updateGroup(groupId: string, updates: ProjectGroupUpdate): Promise<ProjectGroup | null> {
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

  async updateGroups(mutations: readonly ProjectGroupMutation[]): Promise<ProjectGroup[] | null> {
    const store = this.deps.getStore()
    if (!store?.updateProjectGroups) {
      throw new Error('runtime_unavailable')
    }
    const updated = store.updateProjectGroups(mutations)
    if (updated?.length) {
      this.deps.notifyReposChanged()
    }
    return updated
  }

  async moveProject(
    repoSelector: string,
    groupId: string | null,
    order?: number,
    connectionId?: string | null
  ): Promise<Repo> {
    const store = this.deps.getStore()
    if (!store?.moveProjectToGroup) {
      throw new Error('runtime_unavailable')
    }
    const repo = await this.deps.resolveRepo(repoSelector, connectionId)
    assertWslMoveRepoWritable(store, repo)
    const moved = store.moveProjectToGroup(repo, groupId, order)
    if (!moved) {
      throw new Error('repo_not_found')
    }
    this.deps.notifyReposChanged()
    return moved
  }

  async createFolderWorkspace(
    input: RuntimeGroupFolderCreateInput
  ): Promise<FolderWorkspaceCreateResult> {
    // Every refusal below comes before the store write, so it proves nothing was created.
    const store = this.deps.getStore()
    if (!store?.createFolderWorkspace) {
      throw new FolderWorkspaceCreateRefusedError('runtime_unavailable')
    }
    const createFolder = store.createFolderWorkspace.bind(store)
    const projectGroups = store.getProjectGroups?.() ?? []
    const group = projectGroups.find((entry) => entry.id === input.projectGroupId)
    const folderPath =
      typeof input.folderPath === 'string' && input.folderPath.trim().length > 0
        ? input.folderPath
        : group?.parentPath
    if (!group || !folderPath) {
      throw new FolderWorkspaceCreateRefusedError('folder_workspace_project_group_not_found')
    }
    if (folderPath === input.folderPath) {
      // An explicit folder on a WSL host must not be a Windows drive; refused before any store write.
      await refuseWslHostWindowsDrivePath(folderPath)
    }
    const status = await getFolderWorkspacePathStatusForPath({
      folderPath,
      projectGroupId: group.id,
      connectionId: input.connectionId ?? group.connectionId ?? null,
      projectGroups,
      repos: store.getRepos()
    })
    const pathRefusal = folderWorkspacePathRefusal(status)
    if (pathRefusal) {
      throw new FolderWorkspaceCreateRefusedError(pathRefusal)
    }
    const workspace = await createFolderWorkspaceWithPluginHooks(input, (request) =>
      createFolder({
        ...request,
        creatorProvenance: request.creatorProvenance ?? { kind: 'host' }
      })
    )
    input.onWorkspaceCreated?.(`folder:${workspace.id}`)
    this.deps.notifyReposChanged()
    try {
      return (
        (await this.deps.finishFolderCreation?.(input, group, workspace)) ?? {
          folderWorkspace: workspace
        }
      )
    } catch (error) {
      console.warn('[hooks] group workspace startup failed:', error)
      return {
        folderWorkspace: workspace,
        warning: 'Setup or the agent could not start. Open the workspace and try again.'
      }
    }
  }

  async getFolderPathStatus(
    request: FolderWorkspacePathStatusRequest
  ): Promise<FolderWorkspacePathStatus> {
    const store = this.deps.getStore()
    if (!store) {
      throw new Error('runtime_unavailable')
    }
    return getFolderWorkspacePathStatus(store, request)
  }

  async updateFolderWorkspace(
    folderWorkspaceId: string,
    updates: FolderWorkspaceUpdates,
    options: FolderWorkspaceMutationOptions = {}
  ): Promise<FolderWorkspace | null> {
    const store = this.deps.getStore()
    if (!store?.updateFolderWorkspace) {
      throw new Error('runtime_unavailable')
    }
    assertUniqueIdWhenRequired(store, folderWorkspaceId, options)
    const existing = store.getFolderWorkspaces?.().find((entry) => entry.id === folderWorkspaceId)
    if (
      existing &&
      isLocalWslMoveRow(existing) &&
      shouldDropWslMoveProjectUpdate(store, { folderWorkspaceId }, updates)
    ) {
      return existing
    }
    if (typeof updates.folderPath === 'string' && updates.folderPath.trim().length > 0) {
      const workspace = store
        .getFolderWorkspaces?.()
        .find((entry) => entry.id === folderWorkspaceId)
      if (!workspace) {
        return null
      }
      const projectGroups = store.getProjectGroups?.() ?? []
      const status = await getFolderWorkspacePathStatusForPath({
        folderPath: updates.folderPath,
        projectGroupId: workspace.projectGroupId,
        connectionId:
          workspace.connectionId ??
          projectGroups.find((entry) => entry.id === workspace.projectGroupId)?.connectionId ??
          null,
        projectGroups,
        repos: store.getRepos()
      })
      assertFolderWorkspacePathUsable(status)
      // The path check awaited; a twin added meanwhile must not receive this update.
      assertUniqueIdWhenRequired(store, folderWorkspaceId, options)
    }
    const updated = store.updateFolderWorkspace(folderWorkspaceId, updates)
    if (updated) {
      this.deps.notifyReposChanged()
    }
    return updated
  }

  async deleteFolderWorkspace(
    folderWorkspaceId: string,
    options: FolderWorkspaceMutationOptions = {}
  ): Promise<{ deleted: boolean }> {
    return deleteFolderWorkspaceRow(this.deps, folderWorkspaceId, options)
  }
}
