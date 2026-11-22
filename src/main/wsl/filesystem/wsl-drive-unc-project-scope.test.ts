import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { Repo } from '../../../shared/repository/repo-types'
import { collectWslDriveUncScope } from './wsl-drive-unc-project-scope'

const MOUNTS = [{ mountPoint: '/mnt/c', windowsRoot: 'C:\\' }]
const SRC = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src`
const APP = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`

function repo(path: string, connectionId: string | null = null, id = 'repo-a'): Repo {
  return { id, path, displayName: 'app', badgeColor: '', addedAt: 0, connectionId }
}

function folder(folderPath: string, connectionId: string | null = null): FolderWorkspace {
  return {
    id: 'folder-a',
    projectGroupId: 'group-a',
    name: 'src',
    folderPath,
    connectionId,
    executionHostId: connectionId ? null : 'local',
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
}

describe('collectWslDriveUncScope', () => {
  it('refuses a folder workspace holding a refused repo', () => {
    const state = {
      repos: [repo(APP, 'ssh-1')],
      folderWorkspaces: [folder(SRC)],
      projectGroups: []
    }
    expect(collectWslDriveUncScope(state, 'Ubuntu', MOUNTS)).toEqual({
      repoIds: [],
      folderWorkspaceIds: [],
      refused: [
        { kind: 'repo', id: 'repo-a', reason: 'not-local' },
        { kind: 'folder-workspace', id: 'folder-a', reason: 'overlaps-refused-project' }
      ]
    })
  })

  it('refuses a repo inside a refused folder workspace', () => {
    const state = {
      repos: [repo(APP)],
      folderWorkspaces: [folder(SRC, 'ssh-1')],
      projectGroups: []
    }
    expect(collectWslDriveUncScope(state, 'Ubuntu', MOUNTS)).toEqual({
      repoIds: [],
      folderWorkspaceIds: [],
      refused: [
        { kind: 'folder-workspace', id: 'folder-a', reason: 'not-local' },
        { kind: 'repo', id: 'repo-a', reason: 'overlaps-refused-project' }
      ]
    })
  })

  it('refuses each project nesting with one refused for an overlap, through a chain', () => {
    // The refused repo is in the folder, which holds the other repo; the two repos do not nest.
    const state = {
      repos: [repo(String.raw`${SRC}\lib`, null, 'repo-b'), repo(APP, 'ssh-1')],
      folderWorkspaces: [folder(SRC)],
      projectGroups: []
    }
    expect(collectWslDriveUncScope(state, 'Ubuntu', MOUNTS)).toEqual({
      repoIds: [],
      folderWorkspaceIds: [],
      refused: [
        { kind: 'repo', id: 'repo-a', reason: 'not-local' },
        { kind: 'folder-workspace', id: 'folder-a', reason: 'overlaps-refused-project' },
        { kind: 'repo', id: 'repo-b', reason: 'overlaps-refused-project' }
      ]
    })
  })

  it('refuses a local repo nesting with an SSH repo of the same id', () => {
    const state = {
      repos: [repo(SRC), repo(APP, 'ssh-1')],
      folderWorkspaces: [],
      projectGroups: []
    }
    expect(collectWslDriveUncScope(state, 'Ubuntu', MOUNTS)).toEqual({
      repoIds: [],
      folderWorkspaceIds: [],
      refused: [
        { kind: 'repo', id: 'repo-a', reason: 'not-local' },
        { kind: 'repo', id: 'repo-a', reason: 'overlaps-refused-project' }
      ]
    })
  })

  it('accepts a local repo disjoint from an SSH repo of the same id', () => {
    const state = {
      repos: [repo(SRC), repo(String.raw`\\wsl.localhost\Ubuntu\mnt\c\remote`, 'ssh-1')],
      folderWorkspaces: [],
      projectGroups: []
    }
    expect(collectWslDriveUncScope(state, 'Ubuntu', MOUNTS).repoIds).toEqual(['repo-a'])
  })
})
