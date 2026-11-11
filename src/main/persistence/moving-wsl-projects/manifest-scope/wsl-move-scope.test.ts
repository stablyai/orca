import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { Repo } from '../../../../shared/repo-types'
import { createUncToLinuxPathRewriter } from './wsl-move-path-rewriter'
import { collectWslMoveScope } from './wsl-move-scope'

const unc = (linux: string, distro = 'Ubuntu', host = 'wsl.localhost') =>
  `\\\\${host}\\${distro}${linux.replaceAll('/', '\\')}`

const repo = (id: string, path: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  path,
  displayName: id,
  badgeColor: '#000',
  addedAt: 0,
  ...extra
})

const folder = (id: string, folderPath: string, extra: Partial<FolderWorkspace> = {}) => ({
  id,
  projectGroupId: 'group',
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
  updatedAt: 0,
  ...extra
})

describe('collectWslMoveScope', () => {
  it('refuses a Windows repo that keeps a path in the distro, and a drive-relative base', () => {
    const scope = collectWslMoveScope(
      {
        repos: [
          repo('win-with-wsl-base', 'C:\\src\\app', { worktreeBasePath: unc('/home/dev/trees') }),
          repo('drive-relative', unc('/home/dev/a'), { worktreeBasePath: 'C:trees' })
        ],
        folderWorkspaces: [],
        projectGroups: []
      },
      'Ubuntu'
    )
    expect(scope.refused).toEqual([
      { kind: 'repo', id: 'win-with-wsl-base', reason: 'mixed-locations' },
      { kind: 'repo', id: 'drive-relative', reason: 'mixed-locations' }
    ])
  })

  it('judges each folder workspace by its own row when two hosts share an id', () => {
    const scope = collectWslMoveScope(
      {
        repos: [],
        folderWorkspaces: [
          folder('shared-id', unc('/srv/local')),
          folder('shared-id', unc('/srv/remote'), { executionHostId: 'ssh:target' })
        ],
        projectGroups: []
      },
      'Ubuntu'
    )
    expect(scope.folderWorkspaceIds).toEqual(['shared-id'])
    expect(scope.refused).toEqual([
      { kind: 'folder-workspace', id: 'shared-id', reason: 'not-local' }
    ])
  })
})

describe('createUncToLinuxPathRewriter', () => {
  it('matches a percent-encoded distro name in a file URL', () => {
    expect(
      createUncToLinuxPathRewriter('My Ubuntu').path(
        'file://wsl.localhost/My%20Ubuntu/a.html',
        'url'
      )
    ).toBe('file:///a.html')
  })
})
