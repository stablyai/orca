import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../shared/types'
import type { IFilesystemProvider } from '../providers/types'
import { getFolderWorkspacePathStatus } from './folder-workspace-path-status'

function group(parentPath: string, connectionId?: string | null): ProjectGroup {
  return {
    id: 'shared-group',
    name: 'Platform',
    parentPath,
    connectionId,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function workspace(folderPath: string, connectionId?: string | null): FolderWorkspace {
  return {
    id: 'shared-folder',
    projectGroupId: 'shared-group',
    name: 'Folder',
    folderPath,
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

function repo(path: string, connectionId: string | null): Repo {
  return {
    id: connectionId ? 'ssh-repo' : 'local-repo',
    path,
    displayName: connectionId ? 'SSH repo' : 'Local repo',
    badgeColor: 'gray',
    addedAt: 1,
    projectGroupId: 'shared-group',
    connectionId
  }
}

describe('folder workspace path status ownership', () => {
  it.each([
    { label: 'local-first catalogs', reversed: false },
    { label: 'SSH-first catalogs', reversed: true }
  ])('owner-qualifies same-ID folder and group scopes for $label', async (testCase) => {
    const localRoot = await mkdtemp(join(tmpdir(), 'orca-folder-status-same-id-'))
    const remoteRoot = '/remote/workspace/platform'
    const sshStat = vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 1 })
    const ordered = <T>(local: T, ssh: T): T[] => (testCase.reversed ? [ssh, local] : [local, ssh])
    const store = {
      getRepos: () => ordered(repo(localRoot, null), repo(remoteRoot, 'ssh-1')),
      getProjectGroups: () => ordered(group(localRoot), group(remoteRoot, 'ssh-1')),
      getFolderWorkspaces: () => ordered(workspace(localRoot, null), workspace(remoteRoot, 'ssh-1'))
    }
    const deps = {
      getSshFilesystemProvider: (connectionId: string) =>
        connectionId === 'ssh-1' ? ({ stat: sshStat } as unknown as IFilesystemProvider) : undefined
    }

    try {
      await expect(
        getFolderWorkspacePathStatus(
          store,
          { scope: 'folder-workspace', folderWorkspaceId: 'shared-folder' },
          deps
        )
      ).rejects.toThrow('folder_workspace_path_scope_not_found')
      await expect(
        getFolderWorkspacePathStatus(
          store,
          { scope: 'project-group', projectGroupId: 'shared-group' },
          deps
        )
      ).rejects.toThrow('folder_workspace_path_scope_not_found')

      await expect(
        getFolderWorkspacePathStatus(
          store,
          {
            scope: 'folder-workspace',
            folderWorkspaceId: 'shared-folder',
            executionHostId: 'local'
          },
          deps
        )
      ).resolves.toEqual({ path: localRoot, exists: true })
      await expect(
        getFolderWorkspacePathStatus(
          store,
          {
            scope: 'folder-workspace',
            folderWorkspaceId: 'shared-folder',
            executionHostId: 'ssh:ssh-1'
          },
          deps
        )
      ).resolves.toEqual({ path: remoteRoot, exists: true })
      await expect(
        getFolderWorkspacePathStatus(
          store,
          {
            scope: 'project-group',
            projectGroupId: 'shared-group',
            executionHostId: 'local'
          },
          deps
        )
      ).resolves.toEqual({ path: localRoot, exists: true })
      await expect(
        getFolderWorkspacePathStatus(
          store,
          {
            scope: 'project-group',
            projectGroupId: 'shared-group',
            executionHostId: 'ssh:ssh-1'
          },
          deps
        )
      ).resolves.toEqual({ path: remoteRoot, exists: true })
      expect(sshStat).toHaveBeenCalledTimes(2)
      expect(sshStat).toHaveBeenNthCalledWith(1, remoteRoot)
      expect(sshStat).toHaveBeenNthCalledWith(2, remoteRoot)
    } finally {
      await rm(localRoot, { recursive: true, force: true })
    }
  })

  it('retains qualified access to a unique legacy unstamped scope', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-folder-status-legacy-owner-'))
    try {
      await expect(
        getFolderWorkspacePathStatus(
          {
            getRepos: () => [],
            getProjectGroups: () => [group(root)],
            getFolderWorkspaces: () => [workspace(root)]
          },
          {
            scope: 'folder-workspace',
            folderWorkspaceId: 'shared-folder',
            executionHostId: 'local'
          },
          { getSshFilesystemProvider: () => undefined }
        )
      ).resolves.toEqual({ path: root, exists: true })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects duplicate rows for the requested owner', async () => {
    const localRoot = await mkdtemp(join(tmpdir(), 'orca-folder-status-duplicate-owner-'))
    const duplicate = workspace(localRoot, null)
    try {
      await expect(
        getFolderWorkspacePathStatus(
          {
            getRepos: () => [],
            getProjectGroups: () => [group(localRoot, null)],
            getFolderWorkspaces: () => [duplicate, { ...duplicate }]
          },
          {
            scope: 'folder-workspace',
            folderWorkspaceId: 'shared-folder',
            executionHostId: 'local'
          },
          { getSshFilesystemProvider: () => undefined }
        )
      ).rejects.toThrow('folder_workspace_path_scope_not_found')
    } finally {
      await rm(localRoot, { recursive: true, force: true })
    }
  })
})
