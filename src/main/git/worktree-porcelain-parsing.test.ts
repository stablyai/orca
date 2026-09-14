// parseWorktreeList: porcelain block parsing, lock/prunable markers, NUL-delimited output.
import { describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  moveWorktreeDirectoryToTrashMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  moveWorktreeDirectoryToTrashMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
}))

// Default: the checkout cannot be renamed aside, so removal deletes it in place.
vi.mock('../worktree-trash', () => ({
  moveWorktreeDirectoryToTrash: moveWorktreeDirectoryToTrashMock.mockResolvedValue(undefined),
  restoreWorktreeDirectoryFromTrash: vi.fn().mockResolvedValue(true),
  scheduleWorktreeTrashDeletion: vi.fn()
}))

import { parseWorktreeList } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

describe('parseWorktreeList', () => {
  it('preserves a locked marker and its reason', () => {
    expect(
      parseWorktreeList(
        'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /locked\nHEAD def\nbranch refs/heads/feature\nlocked active agent session\n'
      )[1]
    ).toMatchObject({
      path: '/locked',
      locked: true,
      lockReason: 'active agent session'
    })
  })

  it('decodes C-quoted lock reasons from legacy line porcelain output', () => {
    const output =
      'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /locked\nHEAD def\nbranch refs/heads/feature\nlocked "first line\\nsecond line \\303\\251"\n'

    expect(parseWorktreeList(output)[1]).toMatchObject({
      locked: true,
      lockReason: 'first line\nsecond line é'
    })
  })

  it('keeps NUL-delimited lock reasons raw', () => {
    const output = [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /locked',
      'HEAD def',
      'branch refs/heads/feature',
      'locked "literal\\nquote"',
      ''
    ].join('\0')

    expect(parseWorktreeList(output, { nulDelimited: true })[1]).toMatchObject({
      locked: true,
      lockReason: '"literal\\nquote"'
    })
  })

  it('preserves a prunable marker and its reason', () => {
    expect(
      parseWorktreeList(
        'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\nworktree /stale\nHEAD def\nbranch refs/heads/feature\nprunable gitdir file points to non-existent location\n'
      )[1]
    ).toMatchObject({
      path: '/stale',
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location'
    })
  })

  it('preserves a NUL-delimited prunable marker', () => {
    const output = [
      'worktree /repo',
      'HEAD abc',
      'branch refs/heads/main',
      '',
      'worktree /stale',
      'HEAD def',
      'branch refs/heads/feature',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\0')

    expect(parseWorktreeList(output, { nulDelimited: true })[1]).toMatchObject({
      path: '/stale',
      prunable: true,
      prunableReason: 'gitdir file points to non-existent location'
    })
  })

  it('parses regular and bare worktree blocks from porcelain output', () => {
    const output = `
worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test

worktree /repo-bare
HEAD 0000000
bare
`

    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/repo-bare',
        head: '0000000',
        branch: '',
        isBare: true,
        isMainWorktree: false
      }
    ])
  })

  it('returns empty array for empty string input', () => {
    expect(parseWorktreeList('')).toEqual([])
  })

  it('returns empty array for whitespace-only input', () => {
    expect(parseWorktreeList('   \n\n  \n  ')).toEqual([])
  })

  it('parses a single worktree block', () => {
    const output = `worktree /single-repo
HEAD aaa111
branch refs/heads/main
`
    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/single-repo',
        head: 'aaa111',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])
  })

  it('parses a detached HEAD worktree (no branch line)', () => {
    const output = `worktree /repo-detached
HEAD abc123
detached
`
    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/repo-detached',
        head: 'abc123',
        branch: '',
        isBare: false,
        isMainWorktree: true
      }
    ])
  })

  it('handles extra blank lines between blocks', () => {
    const output = `worktree /repo-a
HEAD aaa111
branch refs/heads/main


worktree /repo-b
HEAD bbb222
branch refs/heads/dev
`
    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/repo-a',
        head: 'aaa111',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/repo-b',
        head: 'bbb222',
        branch: 'refs/heads/dev',
        isBare: false,
        isMainWorktree: false
      }
    ])
  })

  it('returns entry with empty head when HEAD line is missing', () => {
    const output = `worktree /repo-no-head
branch refs/heads/main
`
    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/repo-no-head',
        head: '',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])
  })

  it('correctly captures worktree path with spaces', () => {
    const output = `worktree /path/to/my worktree
HEAD ccc333
branch refs/heads/main
`
    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/path/to/my worktree',
        head: 'ccc333',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])
  })

  it('parses NUL-delimited porcelain output with newline paths', () => {
    const output = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/main',
      '',
      'worktree /repo/linked\nworktree',
      'HEAD def456',
      'branch refs/heads/feature/newline',
      ''
    ].join('\0')

    expect(parseWorktreeList(output, { nulDelimited: true })).toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/repo/linked\nworktree',
        head: 'def456',
        branch: 'refs/heads/feature/newline',
        isBare: false,
        isMainWorktree: false
      }
    ])
  })

  it('parses multiple bare entries mixed with regular entries', () => {
    const output = `worktree /bare-one
HEAD 0000000
bare

worktree /regular
HEAD abc123
branch refs/heads/main

worktree /bare-two
HEAD 1111111
bare
`
    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/bare-one',
        head: '0000000',
        branch: '',
        isBare: true,
        isMainWorktree: true
      },
      {
        path: '/regular',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: false
      },
      {
        path: '/bare-two',
        head: '1111111',
        branch: '',
        isBare: true,
        isMainWorktree: false
      }
    ])
  })
})
