import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import { wslMoveCutoverFixture } from '../../__fixtures__/wsl-mover/wsl-move-cutover-fixture'
import {
  wslMoveLocalRowIdentity,
  wslMoveTakenRowIdentity
} from '../cutover-recovery/wsl-move-retained-source'
import { createWslMoveStringNormalizer } from './wsl-move-canonical-form'
import { createUncToLinuxPathRewriter } from './wsl-move-path-rewriter'
import { collectWslMoveScope } from './wsl-move-scope'
import { rewriteOrcadMigrationWorktreeId } from '../../migrating-orcad-catalog/path-rewrite/orcad-migration-path-rewrite'

const W = { letter: 'W', share: '\\\\wsl.localhost\\Ubuntu' }

const repo = (id: string, path: string, extra: Partial<Repo> = {}): Repo => ({
  id,
  path,
  displayName: id,
  badgeColor: '#000',
  addedAt: 0,
  ...extra
})

const folder = (id: string, folderPath: string): FolderWorkspace => ({
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
  updatedAt: 0
})

describe('collectWslMoveScope with mapped drives', () => {
  const state = {
    repos: [
      repo('app', 'W:\\home\\me\\App', { worktreeBasePath: 'trees' }),
      repo('drvfs', 'W:\\mnt\\c\\src\\site')
    ],
    folderWorkspaces: [folder('notes', 'W:\\home\\me\\Notes')],
    projectGroups: []
  }

  it('takes local W: projects with the mapping and ignores them without it', () => {
    expect(collectWslMoveScope(state, 'Ubuntu', { mappedDrives: [W] })).toEqual({
      repoIds: ['app'],
      folderWorkspaceIds: ['notes'],
      refused: [{ kind: 'repo', id: 'drvfs', reason: 'windows-drive' }]
    })
    expect(collectWslMoveScope(state, 'Ubuntu')).toEqual({
      repoIds: [],
      folderWorkspaceIds: [],
      refused: []
    })
  })

  it('refuses a mapped-drive repo the host Git cannot take, with its reason', () => {
    const scope = collectWslMoveScope(state, 'Ubuntu', {
      mappedDrives: [W],
      windowsGitRefusals: new Map([['app', 'windows-git-dir' as const]])
    })
    expect(scope.refused).toContainEqual({ kind: 'repo', id: 'app', reason: 'windows-git-dir' })
  })

  it('lists local projects of a drive that did not answer instead of dropping them', () => {
    expect(collectWslMoveScope(state, 'Ubuntu', { unverifiableLetters: ['W'] })).toEqual({
      repoIds: [],
      folderWorkspaceIds: [],
      refused: [
        { kind: 'repo', id: 'app', reason: 'mapped-drive-unverifiable' },
        { kind: 'repo', id: 'drvfs', reason: 'mapped-drive-unverifiable' },
        { kind: 'folder-workspace', id: 'notes', reason: 'mapped-drive-unverifiable' }
      ]
    })
  })
})

describe('the move path rewriter with mapped drives', () => {
  const rewriter = createUncToLinuxPathRewriter('Ubuntu', [W])

  it('rewrites W: worktree ids, paths and file URLs to Linux', () => {
    expect(rewriteOrcadMigrationWorktreeId('repoId::W:\\home\\me\\App', rewriter)).toBe(
      'repoId::/home/me/App'
    )
    expect(rewriter.path('W:\\home\\me\\App\\src', 'maybe-absolute')).toBe('/home/me/App/src')
    expect(rewriter.path('file:///W:/home/me/App/x.ts', 'url')).toBe('file:///home/me/App/x.ts')
  })

  it('gives a folded w:/ key back the case of the moved root holding it', () => {
    const roots = createUncToLinuxPathRewriter('Ubuntu', [W], { linuxRoots: ['/home/me/App'] })
    expect(roots.path('w:/home/me/app/src', 'absolute')).toBe('/home/me/App/src')
    expect(roots.path('W:\\home\\me\\App\\Src', 'absolute')).toBe('/home/me/App/Src')
  })

  it('leaves a path on an unmapped letter untouched', () => {
    expect(rewriter.path('X:\\home\\me\\App', 'absolute')).toBe('X:\\home\\me\\App')
    expect(rewriter.path('file:///X:/home/me', 'url')).toBe('file:///X:/home/me')
    expect(createUncToLinuxPathRewriter('Ubuntu').path('W:\\home\\me', 'absolute')).toBe(
      'W:\\home\\me'
    )
  })
})

describe('the move normalizer with mapped drives', () => {
  const normalize = createWslMoveStringNormalizer({
    distro: 'Ubuntu',
    hostAliases: [],
    mappedDrives: [W]
  })

  it('normalizes W: and UNC spellings of the same identity equally', () => {
    const unc = '\\\\wsl.localhost\\Ubuntu\\home\\me\\App'
    for (const [drive, share] of [
      ['W:\\home\\me\\App', unc],
      ['repoId::W:\\home\\me\\App', `repoId::${unc}`],
      ['worktree:repoId::W:\\home\\me\\App', `worktree:repoId::${unc}`],
      ['file:///W:/home/me/App/x.ts', 'file://wsl.localhost/Ubuntu/home/me/App/x.ts']
    ]) {
      expect(normalize(drive)).toBe(normalize(share))
      expect(normalize(drive)).not.toBe(drive)
    }
    expect(normalize('X:\\home\\me\\App')).toBe('X:\\home\\me\\App')
  })
})

describe('a retained mapped-drive row', () => {
  it('keeps the identity the move took, read with its mapping', () => {
    const cutover = wslMoveCutoverFixture('move-1', 'retained', { mappedDrives: [W] }, {})
    const row = repo('repo-1', 'W:\\home\\dev\\repo-1')
    const taken = wslMoveTakenRowIdentity(cutover, { kind: 'repo', id: 'repo-1' })
    expect(wslMoveLocalRowIdentity(row, 'Ubuntu', cutover.mappedDrives)).toBe(taken)
    expect(wslMoveLocalRowIdentity(row, 'Ubuntu')).not.toBe(taken)
  })
})
