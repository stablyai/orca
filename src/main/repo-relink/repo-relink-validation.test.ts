import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { parseRepoRelinkError } from '../../shared/repo-path-status'
import {
  createSshRepoHostFilesystem,
  type HostPathKind,
  type RepoHostFilesystem
} from './repo-host-filesystem'
import type { RepoRelinkHostGit } from './repo-relink-host-git'
import { validateRepoRelinkTarget, type RepoRelinkValidationInput } from './repo-relink-validation'
import type { IFilesystemProvider } from '../providers/types'

const repo: Repo = {
  id: 'repo-1',
  path: '/old/app',
  displayName: 'app',
  badgeColor: '#000000',
  addedAt: 0,
  gitRemoteIdentity: {
    canonicalKey: 'example.com/team/app',
    remoteName: 'origin',
    remoteUrl: 'git@example.com:team/app.git'
  }
}

function fakeFs(
  kinds: Record<string, HostPathKind>,
  realPaths: Record<string, string> = {}
): RepoHostFilesystem {
  return {
    inspectEntry: async (path) => kinds[path] ?? 'absent',
    inspectTarget: async (path) => {
      const kind = kinds[realPaths[path] ?? path] ?? 'absent'
      return kind === 'symlink' ? 'directory' : kind
    },
    resolveRealPath: async (path) =>
      realPaths[path] ?? (kinds[path] && kinds[path] !== 'absent' ? path : null),
    join: (base, segment) => `${base}/${segment}`
  }
}

function fakeGit(options: {
  toplevels?: Record<string, string>
  remotes?: Record<string, string[]>
  worktrees?: Record<string, GitWorktreeInfo[]>
}): RepoRelinkHostGit {
  return {
    showToplevel: async (path) => {
      const toplevel = options.toplevels?.[path]
      return toplevel ? { kind: 'toplevel', path: toplevel } : { kind: 'not-repo' }
    },
    listWorktrees: async (path) => options.worktrees?.[path] ?? [],
    readRemoteKeys: async (path) => ({ kind: 'resolved', keys: options.remotes?.[path] ?? [] })
  }
}

function worktree(path: string, isMainWorktree = false): GitWorktreeInfo {
  return { path, head: 'abc', branch: 'refs/heads/main', isBare: false, isMainWorktree }
}

function input(overrides: Partial<RepoRelinkValidationInput>): RepoRelinkValidationInput {
  return {
    repo,
    requestedPath: '/new/app',
    registeredRepos: [repo],
    knownLinkedWorktreePaths: [],
    force: false,
    fs: fakeFs({ '/new/app': 'directory' }),
    git: fakeGit({ toplevels: { '/new/app': '/new/app' } }),
    ...overrides
  }
}

async function refusalCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
  } catch (error) {
    return parseRepoRelinkError(error instanceof Error ? error.message : '')?.code
  }
  return undefined
}

describe('validateRepoRelinkTarget', () => {
  it('accepts the same repository proven by a shared remote', async () => {
    const plan = await validateRepoRelinkTarget(
      input({
        git: fakeGit({
          toplevels: { '/new/app': '/new/app' },
          remotes: { '/new/app': ['example.com/fork/app', 'example.com/team/app'] }
        })
      })
    )
    expect(plan).toMatchObject({
      oldPath: '/old/app',
      newPath: '/new/app',
      evidence: 'remote-identity'
    })
  })

  it('accepts a repository whose worktree list names a linked worktree Orca tracks', async () => {
    const plan = await validateRepoRelinkTarget(
      input({
        repo: { ...repo, gitRemoteIdentity: null },
        knownLinkedWorktreePaths: ['/wt/feature'],
        git: fakeGit({
          toplevels: { '/new/app': '/new/app' },
          worktrees: { '/new/app': [worktree('/new/app', true), worktree('/wt/feature')] }
        })
      })
    )
    expect(plan.evidence).toBe('shared-worktrees')
    expect(plan.gitWorktrees).toHaveLength(2)
  })

  it('accepts the target of a symlink left at the old path', async () => {
    const plan = await validateRepoRelinkTarget(
      input({
        repo: { ...repo, gitRemoteIdentity: null },
        fs: fakeFs({ '/old/app': 'symlink', '/new/app': 'directory' }, { '/old/app': '/new/app' })
      })
    )
    expect(plan.evidence).toBe('path-alias')
  })

  it('refuses another repository unless forced', async () => {
    const other = input({
      git: fakeGit({
        toplevels: { '/new/app': '/new/app' },
        remotes: { '/new/app': ['example.com/team/other'] }
      })
    })
    expect(await refusalCode(validateRepoRelinkTarget(other))).toBe(
      'repo_relink_different_repository'
    )
    await expect(validateRepoRelinkTarget({ ...other, force: true })).resolves.toMatchObject({
      evidence: 'forced'
    })
  })

  it('refuses an unverifiable identity unless forced', async () => {
    const unverified = input({ repo: { ...repo, gitRemoteIdentity: null } })
    expect(await refusalCode(validateRepoRelinkTarget(unverified))).toBe(
      'repo_relink_identity_unverified'
    )
    await expect(validateRepoRelinkTarget({ ...unverified, force: true })).resolves.toMatchObject({
      evidence: 'forced'
    })
  })

  it('refuses a folder inside a repository, even when forced', async () => {
    const nested = input({
      requestedPath: '/new/app/src',
      fs: fakeFs({ '/new/app/src': 'directory' }),
      git: fakeGit({ toplevels: { '/new/app/src': '/new/app' } }),
      force: true
    })
    expect(await refusalCode(validateRepoRelinkTarget(nested))).toBe('repo_relink_not_git_toplevel')
  })

  it('refuses a folder that is not a Git repository', async () => {
    expect(
      await refusalCode(validateRepoRelinkTarget(input({ git: fakeGit({}), force: true })))
    ).toBe('repo_relink_not_git_toplevel')
  })

  it('refuses a missing path, a file, and a relative path', async () => {
    expect(await refusalCode(validateRepoRelinkTarget(input({ fs: fakeFs({}) })))).toBe(
      'repo_relink_path_not_found'
    )
    expect(
      await refusalCode(validateRepoRelinkTarget(input({ fs: fakeFs({ '/new/app': 'file' }) })))
    ).toBe('repo_relink_path_not_directory')
    expect(await refusalCode(validateRepoRelinkTarget(input({ requestedPath: 'app' })))).toBe(
      'repo_relink_path_not_absolute'
    )
  })

  it('refuses a folder another registered repo already uses on the same host', async () => {
    const owner: Repo = { ...repo, id: 'repo-2', path: '/new/app', displayName: 'other' }
    expect(
      await refusalCode(validateRepoRelinkTarget(input({ registeredRepos: [repo, owner] })))
    ).toBe('repo_relink_path_registered')
  })

  it('reports an unreachable host as unverifiable, never as a missing path', async () => {
    expect(await refusalCode(validateRepoRelinkTarget(input({ fs: null })))).toBe(
      'repo_relink_host_unverifiable'
    )
  })

  it('validates an SSH path on the host through its filesystem provider', async () => {
    const sshRepo: Repo = { ...repo, connectionId: 'box', executionHostId: 'ssh:box' }
    const provider = {
      stat: vi.fn(async (path: string) => {
        if (path === '/home/me/app') {
          return { size: 0, type: 'directory' as const, mtime: 0 }
        }
        throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
      }),
      realpath: vi.fn(async (path: string) => path)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: validation only calls stat/lstat/realpath, all stubbed above.
    const fs = createSshRepoHostFilesystem(provider as unknown as IFilesystemProvider)
    const plan = await validateRepoRelinkTarget(
      input({
        repo: sshRepo,
        registeredRepos: [sshRepo],
        requestedPath: '/home/me/app',
        fs,
        git: fakeGit({
          toplevels: { '/home/me/app': '/home/me/app' },
          remotes: { '/home/me/app': ['example.com/team/app'] }
        })
      })
    )
    expect(plan.newPath).toBe('/home/me/app')
    expect(provider.stat).toHaveBeenCalledWith('/home/me/app')
    expect(
      await refusalCode(
        validateRepoRelinkTarget(
          input({ repo: sshRepo, registeredRepos: [sshRepo], requestedPath: '/home/me/gone', fs })
        )
      )
    ).toBe('repo_relink_path_not_found')
  })

  it('refuses folder-mode projects', async () => {
    expect(
      await refusalCode(validateRepoRelinkTarget(input({ repo: { ...repo, kind: 'folder' } })))
    ).toBe('repo_relink_folder_repo_unsupported')
  })
})
