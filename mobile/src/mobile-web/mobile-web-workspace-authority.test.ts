import { describe, expect, it } from 'vitest'
import { MobileWebWorkspaceAuthority } from './mobile-web-workspace-authority'

describe('mobile web workspace authority', () => {
  it('issues stable opaque handles and resolves only current workspace bindings', () => {
    const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length).fill(7))
    authority.synchronize(['repo::/private/worktree', 'repo::C:\\private\\second'])

    const first = authority.pageWorkspaceId('repo::/private/worktree')
    const second = authority.pageWorkspaceId('repo::C:\\private\\second')

    expect(first).toMatch(/^workspace_0_[a-f0-9]{32}$/)
    expect(second).toMatch(/^workspace_1_[a-f0-9]{32}$/)
    expect(`${first}${second}`).not.toContain('private')
    expect(authority.hostWorkspaceId(first)).toBe('repo::/private/worktree')
    expect(() =>
      authority.assertHostWorkspaceBinding(first, 'repo::/private/worktree')
    ).not.toThrow()

    authority.synchronize(['repo::C:\\private\\second'])
    expect(() => authority.hostWorkspaceId(first)).toThrow('not_found')
    expect(() => authority.assertHostWorkspaceBinding(first, 'repo::/private/worktree')).toThrow(
      'not_found'
    )
    expect(authority.pageWorkspaceId('repo::C:\\private\\second')).toBe(second)
  })

  it('revokes every mapping when the shell session is cleared', () => {
    const authority = new MobileWebWorkspaceAuthority((length) => new Uint8Array(length))
    authority.synchronize(['host-workspace'])
    const pageWorkspaceId = authority.pageWorkspaceId('host-workspace')

    authority.clear()

    expect(() => authority.hostWorkspaceId(pageWorkspaceId)).toThrow('not_found')
    expect(() => authority.pageWorkspaceId('host-workspace')).toThrow('not_found')
  })
})
