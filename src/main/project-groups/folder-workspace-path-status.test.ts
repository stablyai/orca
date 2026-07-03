import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  getFolderWorkspacePathStatus,
  getFolderWorkspacePathStatusForPath,
  inferFolderWorkspacePathConnection
} from './folder-workspace-path-status'
import type { IFilesystemProvider } from '../providers/types'
import type { ProjectGroup, Repo } from '../../shared/types'

function makeGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/workspace/platform',
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/platform/api',
    displayName: 'api',
    badgeColor: 'gray',
    addedAt: 1,
    projectGroupId: 'group-1',
    ...overrides
  }
}

describe('folder workspace path status', () => {
  it('reports existing local directories and local files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-folder-status-'))
    try {
      const filePath = join(root, 'notes.txt')
      await writeFile(filePath, 'hello')

      await expect(
        getFolderWorkspacePathStatusForPath(
          {
            folderPath: root,
            projectGroupId: 'group-1',
            projectGroups: [makeGroup({ parentPath: root })],
            repos: []
          },
          { getSshFilesystemProvider: () => undefined }
        )
      ).resolves.toEqual({ path: root, exists: true })

      await expect(
        getFolderWorkspacePathStatusForPath(
          {
            folderPath: filePath,
            projectGroupId: 'group-1',
            projectGroups: [makeGroup({ parentPath: filePath })],
            repos: []
          },
          { getSshFilesystemProvider: () => undefined }
        )
      ).resolves.toEqual({ path: filePath, exists: false, reason: 'not-directory' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports missing local directories', async () => {
    const missingPath = join(tmpdir(), `orca-folder-status-missing-${randomUUID()}`)

    await expect(
      getFolderWorkspacePathStatusForPath(
        {
          folderPath: missingPath,
          projectGroupId: 'group-1',
          projectGroups: [makeGroup({ parentPath: missingPath })],
          repos: []
        },
        { getSshFilesystemProvider: () => undefined }
      )
    ).resolves.toEqual({ path: missingPath, exists: false, reason: 'missing' })
  })

  it('routes inferred SSH folder scopes through the SSH filesystem provider', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 1 })
    } as unknown as IFilesystemProvider

    await expect(
      getFolderWorkspacePathStatusForPath(
        {
          folderPath: '/workspace/platform',
          projectGroupId: 'group-1',
          projectGroups: [makeGroup()],
          repos: [makeRepo({ connectionId: 'ssh-1' })]
        },
        { getSshFilesystemProvider: () => provider }
      )
    ).resolves.toEqual({ path: '/workspace/platform', exists: true })
    expect(provider.stat).toHaveBeenCalledWith('/workspace/platform')
  })

  it('routes explicit SSH folder scopes through SSH without child repos', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 1 })
    } as unknown as IFilesystemProvider

    await expect(
      getFolderWorkspacePathStatusForPath(
        {
          folderPath: '/workspace/platform',
          projectGroupId: 'group-1',
          connectionId: 'ssh-1',
          projectGroups: [makeGroup({ connectionId: 'ssh-1' })],
          repos: []
        },
        { getSshFilesystemProvider: () => provider }
      )
    ).resolves.toEqual({ path: '/workspace/platform', exists: true })
    expect(provider.stat).toHaveBeenCalledWith('/workspace/platform')
  })

  it('reports unavailable when an inferred SSH provider is missing', async () => {
    await expect(
      getFolderWorkspacePathStatusForPath(
        {
          folderPath: '/workspace/platform',
          projectGroupId: 'group-1',
          projectGroups: [makeGroup()],
          repos: [makeRepo({ connectionId: 'ssh-1' })]
        },
        { getSshFilesystemProvider: () => undefined }
      )
    ).resolves.toEqual({ path: '/workspace/platform', exists: false, reason: 'unavailable' })
  })

  it('reports ambiguous connection for mixed SSH scopes', () => {
    expect(
      inferFolderWorkspacePathConnection({
        folderPath: '/workspace/platform',
        projectGroupId: 'group-1',
        projectGroups: [makeGroup()],
        repos: [
          makeRepo({ id: 'repo-1', connectionId: 'ssh-1' }),
          makeRepo({ id: 'repo-2', connectionId: 'ssh-2' })
        ]
      })
    ).toEqual({ kind: 'ambiguous' })
  })

  it('reports ambiguous connection for mixed local and SSH scopes', () => {
    expect(
      inferFolderWorkspacePathConnection({
        folderPath: '/workspace/platform',
        projectGroupId: 'group-1',
        projectGroups: [makeGroup()],
        repos: [
          makeRepo({ id: 'repo-1', connectionId: undefined }),
          makeRepo({ id: 'repo-2', connectionId: 'ssh-1' })
        ]
      })
    ).toEqual({ kind: 'ambiguous' })
  })

  it('reports ambiguous connection when explicit SSH scope conflicts with repos', () => {
    expect(
      inferFolderWorkspacePathConnection({
        folderPath: '/workspace/platform',
        projectGroupId: 'group-1',
        connectionId: 'ssh-1',
        projectGroups: [makeGroup({ connectionId: 'ssh-1' })],
        repos: [
          makeRepo({ id: 'repo-1', connectionId: 'ssh-1' }),
          makeRepo({ id: 'repo-2', connectionId: 'ssh-2' })
        ]
      })
    ).toEqual({ kind: 'ambiguous' })
  })

  it('supports direct path scope without a persisted project group', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 1 })
    } as unknown as IFilesystemProvider

    await expect(
      getFolderWorkspacePathStatus(
        {
          getRepos: () => [makeRepo({ connectionId: 'ssh-1' })],
          getProjectGroups: () => [],
          getFolderWorkspaces: () => []
        },
        { scope: 'path', path: '/workspace/platform', connectionId: 'ssh-1' },
        { getSshFilesystemProvider: () => provider }
      )
    ).resolves.toEqual({ path: '/workspace/platform', exists: true })
    expect(provider.stat).toHaveBeenCalledWith('/workspace/platform')
  })

  it('keeps explicit SSH scopes isolated from unrelated same-path SSH repos', async () => {
    const provider = {
      stat: vi.fn().mockResolvedValue({ size: 0, type: 'directory', mtime: 1 })
    } as unknown as IFilesystemProvider

    await expect(
      getFolderWorkspacePathStatusForPath(
        {
          folderPath: '/workspace/platform',
          projectGroupId: 'group-1',
          connectionId: 'ssh-1',
          projectGroups: [
            makeGroup({ id: 'group-1', connectionId: 'ssh-1' }),
            makeGroup({ id: 'group-2', connectionId: 'ssh-2' })
          ],
          repos: [
            makeRepo({ id: 'repo-1', path: '/workspace/platform/api', connectionId: 'ssh-1' }),
            makeRepo({
              id: 'repo-2',
              path: '/workspace/platform/api',
              projectGroupId: 'group-2',
              connectionId: 'ssh-2'
            })
          ]
        },
        {
          getSshFilesystemProvider: (connectionId) =>
            connectionId === 'ssh-1' ? provider : undefined
        }
      )
    ).resolves.toEqual({ path: '/workspace/platform', exists: true })
    expect(provider.stat).toHaveBeenCalledWith('/workspace/platform')
  })
})
