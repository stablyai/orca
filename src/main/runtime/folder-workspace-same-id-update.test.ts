import { describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace, ProjectGroup } from '../../shared/types'
import {
  registerSshFilesystemProvider,
  unregisterSshFilesystemProvider
} from '../providers/ssh-filesystem-dispatch'
import { OrcaRuntimeService } from './orca-runtime'

const GROUP_ID = 'shared-group'
const WORKSPACE_ID = 'shared-folder'
const SSH_TARGET_ID = 'ssh-owner'
const SSH_HOST_ID = toSshExecutionHostId(SSH_TARGET_ID)

function group(connectionId: string | null): ProjectGroup {
  return {
    id: GROUP_ID,
    name: connectionId ? 'SSH group' : 'Local group',
    parentPath: connectionId ? '/srv/ssh' : '/workspace/local',
    connectionId,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function workspace(connectionId: string | null): FolderWorkspace {
  return {
    id: WORKSPACE_ID,
    projectGroupId: GROUP_ID,
    name: connectionId ? 'SSH folder' : 'Local folder',
    folderPath: '/workspace/shared',
    connectionId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('same-id folder catalog updates', () => {
  it('validates creation against the connection-owned group in either catalog order', async () => {
    const localGroup = group(null)
    const sshGroup = group(SSH_TARGET_ID)
    const stat = vi.fn(async () => ({ type: 'directory' }))
    registerSshFilesystemProvider(SSH_TARGET_ID, { stat } as never)

    try {
      for (const groups of [
        [localGroup, sshGroup],
        [sshGroup, localGroup]
      ]) {
        const createFolderWorkspace = vi.fn(() => ({
          ...workspace(SSH_TARGET_ID),
          folderPath: sshGroup.parentPath!
        }))
        const runtime = new OrcaRuntimeService({
          getRepos: () => [],
          getProjectGroups: () => groups,
          createFolderWorkspace
        } as never)

        await expect(runtime.createFolderWorkspace({ projectGroupId: GROUP_ID })).rejects.toThrow(
          'folder_workspace_project_group_not_found'
        )
        await expect(
          runtime.createFolderWorkspace({
            projectGroupId: GROUP_ID,
            connectionId: SSH_TARGET_ID
          })
        ).resolves.toMatchObject({ folderPath: '/srv/ssh', connectionId: SSH_TARGET_ID })

        expect(stat).toHaveBeenLastCalledWith('/srv/ssh')
        expect(createFolderWorkspace).toHaveBeenCalledWith({
          projectGroupId: GROUP_ID,
          connectionId: SSH_TARGET_ID
        })
      }
    } finally {
      unregisterSshFilesystemProvider(SSH_TARGET_ID)
    }
  })

  it('requires and forwards execution ownership for colliding folder and group IDs', async () => {
    const groups = [group(null), group(SSH_TARGET_ID)]
    const workspaces = [workspace(null), workspace(SSH_TARGET_ID)]
    const hostId = (scope: ProjectGroup | FolderWorkspace): ExecutionHostId =>
      scope.connectionId ? toSshExecutionHostId(scope.connectionId) : 'local'
    const updateProjectGroup = vi.fn(
      (
        id: string,
        updates: Partial<ProjectGroup>,
        options: { executionHostId?: ExecutionHostId } = {}
      ) => {
        const matches = groups.filter(
          (candidate) =>
            candidate.id === id &&
            (!options.executionHostId || hostId(candidate) === options.executionHostId)
        )
        return matches.length === 1 ? Object.assign(matches[0]!, updates) : null
      }
    )
    const updateFolderWorkspace = vi.fn(
      (
        id: string,
        updates: Partial<FolderWorkspace>,
        options: { executionHostId?: ExecutionHostId } = {}
      ) => {
        const matches = workspaces.filter(
          (candidate) =>
            candidate.id === id &&
            (!options.executionHostId || hostId(candidate) === options.executionHostId)
        )
        return matches.length === 1 ? Object.assign(matches[0]!, updates) : null
      }
    )
    const runtime = new OrcaRuntimeService({
      getRepos: () => [],
      getProjectGroups: () => groups,
      getFolderWorkspaces: () => workspaces,
      updateProjectGroup,
      updateFolderWorkspace
    } as never)

    await expect(runtime.updateProjectGroup(GROUP_ID, { name: 'Ambiguous' })).resolves.toBeNull()
    await expect(
      runtime.updateFolderWorkspace(WORKSPACE_ID, { comment: 'Ambiguous' })
    ).resolves.toBeNull()
    await expect(
      runtime.updateProjectGroup(
        GROUP_ID,
        { name: 'Updated SSH group' },
        { executionHostId: SSH_HOST_ID, notify: false }
      )
    ).resolves.toMatchObject({ name: 'Updated SSH group', connectionId: SSH_TARGET_ID })
    await expect(
      runtime.updateFolderWorkspace(
        WORKSPACE_ID,
        { comment: 'Updated SSH folder' },
        { executionHostId: SSH_HOST_ID, notify: false }
      )
    ).resolves.toMatchObject({ comment: 'Updated SSH folder', connectionId: SSH_TARGET_ID })

    expect(updateProjectGroup).toHaveBeenLastCalledWith(
      GROUP_ID,
      { name: 'Updated SSH group' },
      { executionHostId: SSH_HOST_ID }
    )
    expect(updateFolderWorkspace).toHaveBeenLastCalledWith(
      WORKSPACE_ID,
      { comment: 'Updated SSH folder' },
      { executionHostId: SSH_HOST_ID }
    )
    expect(groups[0]?.name).toBe('Local group')
    expect(workspaces[0]?.comment).toBe('')
  })
})
