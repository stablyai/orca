import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { Repo } from '../../shared/repo-types'
import type { WindowsDriveMount } from '../runtime/wsl-guest-drive-mountinfo'
import {
  collectWslDriveUncScope,
  wslDriveUncWorktreeId,
  wslUncDrivePathToWindows
} from './wsl-drive-unc-project-scope'

function repo(id: string, path: string, extra: Partial<Repo> = {}): Repo {
  return { id, displayName: id, path, badgeColor: '', addedAt: 0, ...extra }
}

function folder(id: string, folderPath: string): FolderWorkspace {
  return {
    id,
    projectGroupId: 'g1',
    name: id,
    folderPath,
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

const DRIVES: WindowsDriveMount[] = [
  { mountPoint: '/mnt/c', windowsRoot: 'C:\\' },
  { mountPoint: '/mnt/d', windowsRoot: 'D:\\' }
]

describe('wslUncDrivePathToWindows', () => {
  it.each([
    [String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`, String.raw`C:\src\app`],
    ['//wsl$/ubuntu/mnt/D/work/', String.raw`D:\work`],
    // `/MNT` is an ordinary, case-sensitive Linux folder, as foldWslUncPathCaseInsensitiveParts says.
    ['//wsl$/ubuntu/MNT/d/work/', null],
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
    expect(
      collectWslDriveUncScope(
        {
          repos,
          folderWorkspaces: [folder('f1', String.raw`\\wsl.localhost\Ubuntu\mnt\d\notes`)],
          projectGroups: []
        },
        'Ubuntu',
        DRIVES
      )
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

describe('collectWslDriveUncScope: one folder, one project', () => {
  it('converts one UNC spelling of a drive folder and refuses the others as duplicates', () => {
    const state = {
      repos: [
        repo('first', String.raw`\\wsl$\Ubuntu\mnt\c\src\app`),
        repo('alias', '//wsl.localhost/ubuntu/mnt/c/src/app/')
      ],
      folderWorkspaces: [
        folder('f-first', String.raw`\\wsl.localhost\Ubuntu\mnt\d\notes`),
        folder('f-alias', '//wsl$/ubuntu/mnt/d/notes/'),
        folder('f-drive', String.raw`D:\docs`),
        folder('f-taken', String.raw`\\wsl.localhost\Ubuntu\mnt\d\docs`)
      ],
      projectGroups: []
    }
    expect(collectWslDriveUncScope(state, 'Ubuntu', DRIVES)).toEqual({
      repoIds: ['first'],
      folderWorkspaceIds: ['f-first'],
      refused: [
        { kind: 'repo', id: 'alias', reason: 'duplicate-windows-project' },
        { kind: 'folder-workspace', id: 'f-alias', reason: 'duplicate-windows-project' },
        { kind: 'folder-workspace', id: 'f-taken', reason: 'duplicate-windows-project' }
      ]
    })
  })
})

describe('collectWslDriveUncScope: only real Windows drive folders', () => {
  const state = {
    repos: [
      repo('drive', String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`),
      repo('ext4', String.raw`\\wsl.localhost\Ubuntu\mnt\e\src\app`),
      repo('bind', String.raw`\\wsl.localhost\Ubuntu\mnt\c\shared\app`)
    ],
    folderWorkspaces: [folder('f-ext4', String.raw`\\wsl.localhost\Ubuntu\mnt\e\notes`)],
    projectGroups: []
  }

  it('refuses a /mnt/<letter> folder the distro does not mount from that Windows drive', () => {
    const mounts: WindowsDriveMount[] = [
      ...DRIVES,
      // A subfolder bind mount: its Windows folder is unknown, so it cannot be the drive path.
      { mountPoint: '/mnt/c/shared', windowsRoot: null }
    ]
    expect(collectWslDriveUncScope(state, 'Ubuntu', mounts)).toEqual({
      repoIds: ['drive'],
      folderWorkspaceIds: [],
      refused: [
        { kind: 'repo', id: 'ext4', reason: 'not-windows-drive-mount' },
        { kind: 'repo', id: 'bind', reason: 'not-windows-drive-mount' },
        { kind: 'folder-workspace', id: 'f-ext4', reason: 'not-windows-drive-mount' }
      ]
    })
  })

  it('refuses a drive mounted under another letter, and everything when the mounts are unknown', () => {
    const swapped: WindowsDriveMount[] = [{ mountPoint: '/mnt/c', windowsRoot: 'D:\\' }]
    expect(collectWslDriveUncScope(state, 'Ubuntu', swapped).repoIds).toEqual([])
    expect(collectWslDriveUncScope(state, 'Ubuntu', []).repoIds).toEqual([])
  })

  it('refuses a real /mnt/C directory: only the exact /mnt/c mount point is the C: drive', () => {
    const upper = {
      repos: [repo('upper', String.raw`\\wsl.localhost\Ubuntu\mnt\C\src\app`)],
      folderWorkspaces: [],
      projectGroups: []
    }
    expect(collectWslDriveUncScope(upper, 'Ubuntu', DRIVES)).toEqual({
      repoIds: [],
      folderWorkspaceIds: [],
      refused: [{ kind: 'repo', id: 'upper', reason: 'not-windows-drive-mount' }]
    })
  })
})

describe('collectWslDriveUncScope overlaps', () => {
  it('refuses a project nested with a refused one, whose shared folders would split', () => {
    const repos = [
      repo('outer', String.raw`\\wsl.localhost\Ubuntu\mnt\c\src`, {
        worktreeBasePath: String.raw`\\wsl.localhost\Ubuntu\home\me\trees`
      }),
      repo('inner', String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`),
      repo('beside', String.raw`\\wsl.localhost\Ubuntu\mnt\c\srcx`)
    ]
    expect(
      collectWslDriveUncScope({ repos, folderWorkspaces: [], projectGroups: [] }, 'Ubuntu', DRIVES)
    ).toEqual({
      repoIds: ['beside'],
      folderWorkspaceIds: [],
      refused: [
        { kind: 'repo', id: 'outer', reason: 'mixed-locations' },
        { kind: 'repo', id: 'inner', reason: 'overlaps-refused-project' }
      ]
    })
  })

  it('converts a project nested under a refused duplicate, since its original converts too', () => {
    const repos = [
      repo('outer', String.raw`\\wsl.localhost\Ubuntu\mnt\c\src`),
      repo('outer-alias', '//wsl$/Ubuntu/mnt/c/src/'),
      repo('inner', String.raw`\\wsl.localhost\Ubuntu\mnt\c\src\app`)
    ]
    expect(
      collectWslDriveUncScope({ repos, folderWorkspaces: [], projectGroups: [] }, 'Ubuntu', DRIVES)
    ).toEqual({
      repoIds: ['outer', 'inner'],
      folderWorkspaceIds: [],
      refused: [{ kind: 'repo', id: 'outer-alias', reason: 'duplicate-windows-project' }]
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
