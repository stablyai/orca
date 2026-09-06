import { describe, expect, it } from 'vitest'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('mobile web workspace authority', () => {
  it('issues stable opaque handles and resolves only current workspace bindings', () => {
    const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(7))
    authority.synchronize([
      { workspaceId: 'repo::/private/worktree', repoId: '/private/repo' },
      { workspaceId: 'repo::C:\\private\\second', repoId: '/private/repo' }
    ])

    const first = authority.pageWorkspaceId('repo::/private/worktree')
    const second = authority.pageWorkspaceId('repo::C:\\private\\second')
    const repo = authority.pageRepoId('/private/repo')

    expect(first).toMatch(/^workspace_0_[a-f0-9]{32}$/)
    expect(second).toMatch(/^workspace_2_[a-f0-9]{32}$/)
    expect(repo).toMatch(/^repo_1_[a-f0-9]{32}$/)
    expect(`${first}${second}${repo}`).not.toContain('private')
    expect(authority.hostWorkspaceId(first)).toBe('repo::/private/worktree')
    expect(authority.hostRepoId(repo)).toBe('/private/repo')
    expect(() =>
      authority.assertHostWorkspaceBinding(first, 'repo::/private/worktree')
    ).not.toThrow()
    expect(() => authority.assertHostRepoBinding(repo, '/private/repo')).not.toThrow()

    authority.synchronize([{ workspaceId: 'repo::C:\\private\\second', repoId: '/private/repo' }])
    expect(() => authority.hostWorkspaceId(first)).toThrow('not_found')
    expect(() => authority.assertHostWorkspaceBinding(first, 'repo::/private/worktree')).toThrow(
      'not_found'
    )
    expect(authority.pageWorkspaceId('repo::C:\\private\\second')).toBe(second)
    expect(authority.pageRepoId('/private/repo')).toBe(repo)

    authority.synchronizeRepositories([])
    expect(authority.hostRepoId(repo)).toBe('/private/repo')
    expect(authority.pageRepoId('/private/repo')).toBe(repo)

    authority.synchronize([])
    expect(() => authority.hostRepoId(repo)).toThrow('not_found')
    expect(() => authority.assertHostRepoBinding(repo, '/private/repo')).toThrow('not_found')
  })

  it('revokes a repository handle only after workspace and catalog authority both omit it', () => {
    const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(8))
    authority.synchronize([{ workspaceId: 'folder-workspace', repoId: 'folder-repo' }])
    authority.synchronizeRepositories(['folder-repo'])
    const repo = authority.pageRepoId('folder-repo')

    authority.synchronize([])
    expect(authority.pageRepoId('folder-repo')).toBe(repo)

    authority.synchronizeRepositories([])
    expect(() => authority.hostRepoId(repo)).toThrow('not_found')
  })

  it('revokes every mapping when the shell session is cleared', () => {
    const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
    authority.synchronize([{ workspaceId: 'host-workspace', repoId: 'host-repo' }])
    const pageWorkspaceId = authority.pageWorkspaceId('host-workspace')

    authority.clear()

    expect(() => authority.hostWorkspaceId(pageWorkspaceId)).toThrow('not_found')
    expect(() => authority.pageRepoId('host-repo')).toThrow('not_found')
  })
})
