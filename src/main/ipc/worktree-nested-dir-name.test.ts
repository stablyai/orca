import { describe, expect, it, vi } from 'vitest'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { Repo } from '../../shared/repo-types'

vi.mock('../wsl', () => ({
  getWslHome: vi.fn(),
  getWslHomeAsync: vi.fn(),
  parseWslPath: (path: string) => parseWslUncPath(path)
}))

import {
  assignNestedRepoDirNames,
  remoteOwnerSlug,
  resolveNestedRepoDirName,
  resolveStoreNestedRepoDirName,
  type NestedDirNameSettings
} from './worktree-nested-dir-name'

const NESTED: NestedDirNameSettings = { workspaceDir: '/ws', nestWorkspaces: true }

function repo(id: string, path: string, overrides: Partial<Repo> = {}): Repo {
  return {
    id,
    path,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0,
    ...overrides
  }
}

function identity(canonicalKey: string): Repo['gitRemoteIdentity'] {
  return { canonicalKey, remoteName: 'origin', remoteUrl: `https://${canonicalKey}.git` }
}

const acme = repo('11111111-aaaa', '/src/acme/app', {
  addedAt: 1,
  gitRemoteIdentity: identity('github.com/acme/app')
})
const globex = repo('22222222-bbbb', '/src/globex/app', {
  addedAt: 2,
  gitRemoteIdentity: identity('gitlab.com/globex/app')
})

describe('resolveNestedRepoDirName', () => {
  it('keeps the plain folder name for a repo nobody competes with', () => {
    const other = repo('other', '/src/other', { addedAt: 0 })
    expect(resolveNestedRepoDirName(acme, [acme, other], NESTED)).toBe('app')
    expect(resolveNestedRepoDirName(repo('solo', '/src/app.git'), [], NESTED)).toBe('app')
  })

  it('qualifies the later same-named repo on one root with its remote owner', () => {
    // List order is irrelevant: addedAt decides who keeps the plain name.
    const repos = [globex, acme]
    expect(resolveNestedRepoDirName(acme, repos, NESTED)).toBe('app')
    expect(resolveNestedRepoDirName(globex, repos, NESTED)).toBe('app-globex')
  })

  it('falls back to a short repo id without a remote identity, and for same-owner clones', () => {
    const local = repo('33333333-cccc', '/src/scratch/app', { addedAt: 3 })
    const clone = repo('44444444-dddd', '/src/clone/app', {
      addedAt: 4,
      gitRemoteIdentity: identity('github.com/acme/app')
    })
    const repos = [acme, clone, local]

    expect(resolveNestedRepoDirName(local, [acme, local], NESTED)).toBe('app-33333333')
    const names = assignNestedRepoDirNames([...repos, globex], NESTED)
    expect(Object.fromEntries(names)).toEqual({
      '11111111-aaaa': 'app',
      '22222222-bbbb': 'app-globex',
      '33333333-cccc': 'app-33333333',
      '44444444-dddd': 'app-acme'
    })
  })

  it('treats a repo literally named like a qualified folder as a competitor', () => {
    const literal = repo('55555555-eeee', '/src/tools/app-globex', { addedAt: 0 })
    expect(resolveNestedRepoDirName(globex, [acme, globex, literal], NESTED)).toBe('app-22222222')
  })

  it('does not qualify repos whose roots differ', () => {
    const relative = { ...NESTED, workspaceDir: '.orca/worktrees' }
    expect(resolveNestedRepoDirName(globex, [acme, globex], relative)).toBe('app')

    const ownBase = { ...globex, worktreeBasePath: '/fast/trees' }
    expect(resolveNestedRepoDirName(ownBase, [acme, ownBase], NESTED)).toBe('app')
    const sharedBase = { ...acme, worktreeBasePath: '/fast/trees' }
    expect(resolveNestedRepoDirName(ownBase, [sharedBase, ownBase], NESTED)).toBe('app-globex')
  })

  it('scopes collisions to one execution host', () => {
    const remoteBase = { worktreeBasePath: '/srv/trees' }
    const remoteA = { ...acme, ...remoteBase, connectionId: 'ssh-a' }
    const remoteB = { ...globex, ...remoteBase, connectionId: 'ssh-b' }
    const remoteA2 = { ...globex, ...remoteBase, connectionId: 'ssh-a' }

    expect(resolveNestedRepoDirName(remoteB, [remoteA, remoteB], NESTED)).toBe('app')
    expect(resolveNestedRepoDirName(remoteA2, [remoteA, remoteA2], NESTED)).toBe('app-globex')
    // SSH with a desktop-absolute root never nests, so it claims no folder there.
    const sshFallback = { ...acme, connectionId: 'ssh-a' }
    const sshOwnBase = { ...globex, connectionId: 'ssh-a', worktreeBasePath: '/ws' }
    expect(resolveNestedRepoDirName(sshOwnBase, [sshFallback, sshOwnBase], NESTED)).toBe('app')
  })

  it('folds case on Windows roots but not on POSIX roots', () => {
    const windows = { workspaceDir: 'C:\\ws', nestWorkspaces: true }
    const upper = repo('a', 'C:\\src\\App', { addedAt: 1 })
    const lower = repo('b', 'D:\\other\\app', { addedAt: 2 })
    expect(resolveNestedRepoDirName(lower, [upper, lower], windows)).toBe('app-b')

    const posixUpper = repo('a', '/src/App', { addedAt: 1 })
    const posixLower = repo('b', '/other/app', { addedAt: 2 })
    expect(resolveNestedRepoDirName(posixLower, [posixUpper, posixLower], NESTED)).toBe('app')
  })

  it('compares mirrored WSL roots by distro', () => {
    const windowsRoot = { workspaceDir: 'C:\\ws', nestWorkspaces: true }
    const ubuntuA = repo('a', String.raw`\\wsl.localhost\Ubuntu\home\jin\a\app`, { addedAt: 1 })
    const ubuntuB = repo('b', String.raw`\\wsl.localhost\Ubuntu\home\jin\b\app`, { addedAt: 2 })
    const debian = repo('c', String.raw`\\wsl.localhost\Debian\home\jin\app`, { addedAt: 3 })
    const drive = repo('d', 'C:\\src\\app', { addedAt: 4 })

    expect(resolveNestedRepoDirName(ubuntuB, [ubuntuA, ubuntuB], windowsRoot)).toBe('app-b')
    expect(resolveNestedRepoDirName(debian, [ubuntuA, debian], windowsRoot)).toBe('app')
    // A Windows-drive repo whose git runs in WSL mirrors into that distro too.
    const mirror = (candidate: Repo) => (candidate.id === 'd' ? 'Ubuntu' : undefined)
    expect(resolveNestedRepoDirName(drive, [ubuntuA, drive], windowsRoot, mirror)).toBe('app-d')
    expect(resolveNestedRepoDirName(drive, [ubuntuA, drive], windowsRoot)).toBe('app')
  })

  it('ignores folder workspaces and non-nesting layouts', () => {
    const folder = repo('folder', '/src/folder/app', { addedAt: 0, kind: 'folder' })
    expect(resolveNestedRepoDirName(acme, [folder, acme], NESTED)).toBe('app')
    expect(resolveNestedRepoDirName(folder, [folder], NESTED)).toBeUndefined()
    for (const worktreeLayout of ['flat', 'sibling'] as const) {
      expect(resolveNestedRepoDirName(globex, [acme, globex], { ...NESTED, worktreeLayout })).toBe(
        undefined
      )
      expect(assignNestedRepoDirNames([acme, globex], { ...NESTED, worktreeLayout }).size).toBe(0)
    }
  })

  it('reads peers from the store', () => {
    const store = { getSettings: () => NESTED, getRepos: () => [acme, globex] }
    expect(resolveStoreNestedRepoDirName(store, globex)).toBe('app-globex')
    expect(
      resolveStoreNestedRepoDirName(store, globex, { ...NESTED, worktreeLayout: 'sibling' })
    ).toBeUndefined()
  })
})

describe('remoteOwnerSlug', () => {
  it('derives a filesystem-safe owner for any provider', () => {
    expect(remoteOwnerSlug('github.com/Acme/app')).toBe('acme')
    expect(remoteOwnerSlug('gitlab.com/group/sub/app')).toBe('group-sub')
    expect(remoteOwnerSlug('dev.azure.com/org/project/_git/app')).toBe('org-project')
    expect(remoteOwnerSlug('git.example.com/we ird:owner/app')).toBe('we-ird-owner')
    expect(remoteOwnerSlug('github.com/app')).toBeNull()
    expect(remoteOwnerSlug(undefined)).toBeNull()
  })
})
