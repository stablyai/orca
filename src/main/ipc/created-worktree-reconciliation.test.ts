import { describe, expect, it } from 'vitest'
import { findCreatedWorktree } from './created-worktree-reconciliation'

describe('findCreatedWorktree', () => {
  it('prefers the direct path match', () => {
    const direct = { path: '/home/user/worktrees/feature', branch: 'refs/heads/other' }
    const branch = { path: '/var/home/user/worktrees/feature', branch: 'refs/heads/feature' }

    expect(
      findCreatedWorktree([direct, branch], '/home/user/worktrees/feature', 'feature', 'linux')
    ).toBe(direct)
  })

  it('matches the exact Git-listed branch when the requested path is an alias', () => {
    const created = {
      path: '/var/home/user/worktrees/feature',
      branch: 'refs/heads/user/feature'
    }

    expect(
      findCreatedWorktree(
        [{ path: '/stale/worktree', branch: 'refs/heads/stale' }, created],
        '/home/user/worktrees/feature',
        'user/feature',
        'linux'
      )
    ).toBe(created)
  })

  it('does not accept a branch suffix collision', () => {
    const suffixCollision = {
      path: '/worktrees/prefix-feature',
      branch: 'refs/heads/prefix/feature'
    }

    expect(
      findCreatedWorktree([suffixCollision], '/different/worktrees/feature', 'feature', 'linux')
    ).toBeUndefined()
  })

  it('keeps Windows drive, slash, and case normalization on the direct path', () => {
    const created = {
      path: String.raw`C:\Users\Orca\feature`,
      branch: 'refs/heads/other'
    }

    expect(findCreatedWorktree([created], 'c:/users/orca/feature', 'feature', 'win32')).toBe(
      created
    )
  })

  it.each([
    ['relative POSIX paths', 'worktrees/feature', './worktrees/feature', 'linux' as const],
    [
      'macOS /private/tmp alias',
      '/private/tmp/worktrees/feature',
      '/tmp/worktrees/feature',
      'darwin' as const
    ]
  ])('keeps %s on the direct path', (_case, listed, requested, os) => {
    const created = { path: listed, branch: 'refs/heads/other' }

    expect(findCreatedWorktree([created], requested, 'feature', os)).toBe(created)
  })

  it('keeps non-Windows POSIX path comparison case-sensitive', () => {
    const listed = { path: '/worktrees/Feature', branch: 'refs/heads/other' }

    expect(findCreatedWorktree([listed], '/worktrees/feature', 'feature', 'linux')).toBeUndefined()
  })

  it.each([
    ['WSL', '/home/user/worktrees/feature', '/var/home/user/worktrees/feature', 'win32' as const],
    ['SSH', '/srv/link/feature', '/srv/canonical/feature', 'linux' as const]
  ])(
    'uses Git branch identity without host path resolution for %s',
    (_host, requested, listed, os) => {
      const created = { path: listed, branch: 'refs/heads/feature' }

      expect(findCreatedWorktree([created], requested, 'feature', os)).toBe(created)
    }
  )
})
