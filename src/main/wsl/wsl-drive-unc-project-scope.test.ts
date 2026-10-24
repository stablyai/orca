import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import {
  collectWslDriveUncScope,
  wslDriveUncWorktreeId,
  wslUncDrivePathToWindows
} from './wsl-drive-unc-project-scope'

function repo(id: string, path: string, extra: Partial<Repo> = {}): Repo {
  return { id, displayName: id, path, badgeColor: '', addedAt: 0, ...extra }
}

describe('wslUncDrivePathToWindows', () => {
  it.each([
    [String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`, String.raw`C:\src\app`],
    ['//wsl$/ubuntu/MNT/d/work/', String.raw`D:\work`],
    [String.raw`\\wsl.localhost\Ubuntu\mnt\c`, 'C:\\'],
    [String.raw`\\wsl.localhost\Ubuntu\home\me\app`, null],
    [String.raw`\\wsl.localhost\Debian\mnt\c\src\app`, null],
    [String.raw`C:\src\app`, null]
  ])('%s → %s', (path, expected) => {
    expect(wslUncDrivePathToWindows(path, 'Ubuntu')).toBe(expected)
  })
})

describe('collectWslDriveUncScope', () => {
  it('takes local drive-path projects and refuses mixed, remote and duplicate ones', () => {
    const repos = [
      repo('drive', String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`, {
        worktreeBasePath: 'trees'
      }),
      repo('mixed', String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\mixed`, {
        worktreeBasePath: String.raw`\\wsl.localhost\Ubuntu\home\me\trees`
      }),
      repo('remote', String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\remote`, {
        executionHostId: 'runtime:env-1'
      }),
      repo('dup', String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\dup`),
      repo('already', String.raw`c:\SRC\dup`),
      repo('home', String.raw`\\wsl.localhost\Ubuntu\home\me\app`)
    ]
    const folder: FolderWorkspace = {
      id: 'f1',
      projectGroupId: 'g1',
      name: 'notes',
      folderPath: String.raw`\\wsl.localhost\Ubuntu\mnt\d\notes`,
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
    expect(
      collectWslDriveUncScope({ repos, folderWorkspaces: [folder], projectGroups: [] }, 'Ubuntu')
    ).toEqual({
      repoIds: ['drive'],
      folderWorkspaceIds: ['f1'],
      refused: [
        { kind: 'repo', id: 'mixed', reason: 'mixed-locations' },
        { kind: 'repo', id: 'remote', reason: 'not-local' },
        { kind: 'repo', id: 'dup', reason: 'duplicate-windows-project' }
      ]
    })
  })
})

describe('wslDriveUncWorktreeId', () => {
  it('keeps the repo id and a folder workspace suffix, and maps only drive paths', () => {
    expect(
      wslDriveUncWorktreeId(String.raw`r1::\\wsl.localhost\Ubuntu\mnt\c\src\app`, 'Ubuntu')
    ).toBe(String.raw`r1::C:\src\app`)
    const suffix = '::workspace:0b6f7c3e-8d0f-4b8e-9a51-1f2c3d4e5f60'
    expect(
      wslDriveUncWorktreeId(String.raw`r1::\\wsl.localhost\Ubuntu\mnt\c\src\app${suffix}`, 'Ubuntu')
    ).toBe(String.raw`r1::C:\src\app${suffix}`)
    const home = String.raw`r1::\\wsl.localhost\Ubuntu\home\me\app`
    expect(wslDriveUncWorktreeId(home, 'Ubuntu')).toBe(home)
  })
})
