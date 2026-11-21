import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { Repo } from '../../../shared/repository/repo-types'
import { collectWslDriveUncScope } from './wsl-drive-unc-project-scope'

const MOUNTS = [{ mountPoint: '/mnt/c', windowsRoot: 'C:\\' }]
const SRC = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src`
const APP = String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`

function repo(path: string, connectionId: string | null = null): Repo {
  return { id: 'repo-a', path, displayName: 'app', badgeColor: '', addedAt: 0, connectionId }
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
})
