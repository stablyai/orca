import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  getFolderWorkspacePathStatus,
  getFolderWorkspacePathStatusForPath,
  inferFolderWorkspacePathConnection
} from './folder-workspace-path-status'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'

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
  it.each([false, true])(
    'reports canonical owner ambiguity through the persisted folder status route (%s)',
    async (reverse) => {
      const root = await mkdtemp(join(tmpdir(), 'orca-pr31617-folder-owner-'))
      const workspace: FolderWorkspace = {
        id: 'saved',
        projectGroupId: 'group-1',
        name: 'Saved',
        folderPath: root,
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0
      }
      const repos = [
        makeRepo({ id: 'local', path: join(root, 'local') }),
        makeRepo({ id: 'ssh', path: join(root, 'ssh'), executionHostId: 'ssh:prod' })
      ]
      let folders = [workspace]
      const store = {
        getRepos: () => (reverse ? [...repos].toReversed() : repos),
        getProjectGroups: () => [makeGroup({ parentPath: root })],
        getFolderWorkspaces: () => folders
      }
      try {
        await expect(
          getFolderWorkspacePathStatus(store, {
            scope: 'folder-workspace',
            folderWorkspaceId: 'saved'
          })
        ).resolves.toEqual({
          path: root,
          exists: false,
          reason: 'ambiguous-connection'
        })
        folders = []
        await expect(
          getFolderWorkspacePathStatus(store, {
            scope: 'folder-workspace',
            folderWorkspaceId: 'saved'
          })
        ).rejects.toThrow('folder_workspace_path_scope_not_found')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('reports existing local directories and local files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-folder-status-'))
    try {
      const filePath = join(root, 'notes.txt')
      await writeFile(filePath, 'hello')

      await expect(
        getFolderWorkspacePathStatusForPath({
          folderPath: root,
          projectGroupId: 'group-1',
          projectGroups: [makeGroup({ parentPath: root })],
          repos: []
        })
      ).resolves.toEqual({ path: root, exists: true })

      await expect(
        getFolderWorkspacePathStatusForPath({
          folderPath: filePath,
          projectGroupId: 'group-1',
          projectGroups: [makeGroup({ parentPath: filePath })],
          repos: []
        })
      ).resolves.toEqual({
        path: filePath,
        exists: false,
        reason: 'not-directory'
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports missing local directories', async () => {
    const missingPath = join(tmpdir(), `orca-folder-status-missing-${randomUUID()}`)

    await expect(
      getFolderWorkspacePathStatusForPath({
        folderPath: missingPath,
        projectGroupId: 'group-1',
        projectGroups: [makeGroup({ parentPath: missingPath })],
        repos: []
      })
    ).resolves.toEqual({ path: missingPath, exists: false, reason: 'missing' })
  })

  it('reports unavailable for an inferred SSH scope, which this process does not serve', async () => {
    await expect(
      getFolderWorkspacePathStatusForPath({
        folderPath: '/workspace/platform',
        projectGroupId: 'group-1',
        projectGroups: [makeGroup()],
        repos: [makeRepo({ connectionId: 'ssh-1' })]
      })
    ).resolves.toEqual({
      path: '/workspace/platform',
      exists: false,
      reason: 'unavailable'
    })
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

  it('reports a direct SSH path scope unavailable without a persisted project group', async () => {
    await expect(
      getFolderWorkspacePathStatus(
        {
          getRepos: () => [makeRepo({ connectionId: 'ssh-1' })],
          getProjectGroups: () => [],
          getFolderWorkspaces: () => []
        },
        { scope: 'path', path: '/workspace/platform', connectionId: 'ssh-1' }
      )
    ).resolves.toEqual({
      path: '/workspace/platform',
      exists: false,
      reason: 'unavailable'
    })
  })

  it('keeps explicit SSH scopes isolated from unrelated same-path SSH repos', () => {
    expect(
      inferFolderWorkspacePathConnection({
        folderPath: '/workspace/platform',
        projectGroupId: 'group-1',
        connectionId: 'ssh-1',
        projectGroups: [
          makeGroup({ id: 'group-1', connectionId: 'ssh-1' }),
          makeGroup({ id: 'group-2', connectionId: 'ssh-2' })
        ],
        repos: [
          makeRepo({
            id: 'repo-1',
            path: '/workspace/platform/api',
            connectionId: 'ssh-1'
          }),
          makeRepo({
            id: 'repo-2',
            path: '/workspace/platform/api',
            projectGroupId: 'group-2',
            connectionId: 'ssh-2'
          })
        ]
      })
    ).toEqual({ kind: 'ssh', connectionId: 'ssh-1' })
  })
})
