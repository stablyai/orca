import { describe, expect, it } from 'vitest'
import {
  findConfirmedCreatedWorktree,
  findCreatedWorktree,
  isAmbiguousSshWorktreeAddError
} from './created-worktree-reconciliation'

describe('isAmbiguousSshWorktreeAddError', () => {
  it.each(['CONNECTION_LOST', 'DISPOSED'])('accepts an in-flight %s transport failure', (code) => {
    expect(
      isAmbiguousSshWorktreeAddError(Object.assign(new Error('transport lost'), { code }))
    ).toBe(true)
  })

  it('accepts the SSH request timeout shape', () => {
    expect(
      isAmbiguousSshWorktreeAddError(new Error('Request "git.addWorktree" timed out after 30000ms'))
    ).toBe(true)
  })

  it.each([
    new Error('fatal: target already exists'),
    new Error('Multiplexer disposed'),
    Object.assign(new Error('git rejected the add'), { code: -32_000 }),
    new Error('Request "git.listWorktrees" timed out after 30000ms')
  ])('rejects deterministic or pre-acceptance failures', (error) => {
    expect(isAmbiguousSshWorktreeAddError(error)).toBe(false)
  })
})

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

describe('findConfirmedCreatedWorktree', () => {
  it('requires both the requested path and exact branch', () => {
    const created = {
      path: '/home/user/worktrees/feature',
      branch: 'refs/heads/user/feature'
    }

    expect(
      findConfirmedCreatedWorktree(
        [created],
        '/home/user/worktrees/feature',
        'user/feature',
        'linux'
      )
    ).toBe(created)
  })

  it('rejects the same branch at an unrelated path', () => {
    const unrelated = {
      path: '/home/user/worktrees/other',
      branch: 'refs/heads/user/feature'
    }

    expect(
      findConfirmedCreatedWorktree(
        [unrelated],
        '/home/user/worktrees/feature',
        'user/feature',
        'linux'
      )
    ).toBeUndefined()
  })

  it('rejects an unrelated branch at the requested path', () => {
    const unrelated = {
      path: '/home/user/worktrees/feature',
      branch: 'refs/heads/user/other'
    }

    expect(
      findConfirmedCreatedWorktree(
        [unrelated],
        '/home/user/worktrees/feature',
        'user/feature',
        'linux'
      )
    ).toBeUndefined()
  })
})
