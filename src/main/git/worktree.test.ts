import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock, execFileSyncMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  execFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFile: execFileMock,
  execFileSync: execFileSyncMock
}))

import { addWorktree, parseWorktreeList } from './worktree'

describe('parseWorktreeList', () => {
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

describe('addWorktree', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    execFileSyncMock.mockReset()
  })

  it('fast-forwards the local base branch before creating the worktree when safe', () => {
    execFileSyncMock
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)

    addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')

    expect(execFileSyncMock.mock.calls).toEqual([
      [
        'git',
        ['merge-base', '--is-ancestor', 'main', 'origin/main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        'git',
        ['status', '--porcelain', '--untracked-files=no'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        'git',
        ['update-ref', 'refs/heads/main', 'origin/main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        'git',
        ['worktree', 'add', '-b', 'feature/test', '/repo-feature', 'origin/main'],
        expect.objectContaining({ cwd: '/repo' })
      ]
    ])
  })

  it('skips updating the local branch when the main worktree is dirty', () => {
    execFileSyncMock
      .mockReturnValueOnce('')
      .mockReturnValueOnce(' M package.json\n')
      .mockReturnValueOnce(undefined)

    addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')

    expect(execFileSyncMock.mock.calls).toEqual([
      [
        'git',
        ['merge-base', '--is-ancestor', 'main', 'origin/main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        'git',
        ['status', '--porcelain', '--untracked-files=no'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        'git',
        ['worktree', 'add', '-b', 'feature/test', '/repo-feature', 'origin/main'],
        expect.objectContaining({ cwd: '/repo' })
      ]
    ])
  })

  it('skips updating the local branch when it has diverged and still creates the worktree', () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('not a fast-forward')
    })
    execFileSyncMock.mockReturnValueOnce(undefined)

    addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')

    expect(execFileSyncMock.mock.calls).toEqual([
      [
        'git',
        ['merge-base', '--is-ancestor', 'main', 'origin/main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        'git',
        ['worktree', 'add', '-b', 'feature/test', '/repo-feature', 'origin/main'],
        expect.objectContaining({ cwd: '/repo' })
      ]
    ])
  })

  it('uses the remote name from the base ref instead of hardcoding origin', () => {
    execFileSyncMock
      .mockReturnValueOnce('')
      .mockReturnValueOnce('')
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)

    addWorktree('/repo', '/repo-feature', 'feature/test', 'upstream/main')

    expect(execFileSyncMock.mock.calls[0]?.[1]).toEqual([
      'merge-base',
      '--is-ancestor',
      'main',
      'upstream/main'
    ])
    expect(execFileSyncMock.mock.calls[2]?.[1]).toEqual([
      'update-ref',
      'refs/heads/main',
      'upstream/main'
    ])
  })
})
