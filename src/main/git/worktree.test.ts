/* eslint-disable max-lines -- Why: addWorktree has multiple code paths (no refresh,
   reset --hard vs update-ref, dirty worktree, diverged branch, custom remote) that each
   need dedicated test coverage. Splitting into separate files would scatter related tests
   without a meaningful boundary. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, gitExecFileSyncMock, translateWslOutputPathsMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileSyncMock: vi.fn(),
    translateWslOutputPathsMock: vi.fn((output: string) => output)
  })
)

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
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
        isMainWorktree: true,
        isPrunable: false
      },
      {
        path: '/repo-feature',
        head: 'def456',
        branch: 'refs/heads/feature/test',
        isBare: false,
        isMainWorktree: false,
        isPrunable: false
      },
      {
        path: '/repo-bare',
        head: '0000000',
        branch: '',
        isBare: true,
        isMainWorktree: false,
        isPrunable: false
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
        isMainWorktree: true,
        isPrunable: false
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
        isMainWorktree: true,
        isPrunable: false
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
        isMainWorktree: true,
        isPrunable: false
      },
      {
        path: '/repo-b',
        head: 'bbb222',
        branch: 'refs/heads/dev',
        isBare: false,
        isMainWorktree: false,
        isPrunable: false
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
        isMainWorktree: true,
        isPrunable: false
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
        isMainWorktree: true,
        isPrunable: false
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
        isMainWorktree: true,
        isPrunable: false
      },
      {
        path: '/regular',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: false,
        isPrunable: false
      },
      {
        path: '/bare-two',
        head: '1111111',
        branch: '',
        isBare: true,
        isMainWorktree: false,
        isPrunable: false
      }
    ])
  })
  it('parses prunable worktree entries', () => {
    const output = `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-stale
HEAD 0000000
branch refs/heads/feature/old
prunable gitdir file points to non-existent location
`
    expect(parseWorktreeList(output)).toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true,
        isPrunable: false
      },
      {
        path: '/repo-stale',
        head: '0000000',
        branch: 'refs/heads/feature/old',
        isBare: false,
        isMainWorktree: false,
        isPrunable: true
      }
    ])
  })
})

describe('addWorktree', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
  })

  it('creates the worktree without touching the local base ref by default', () => {
    gitExecFileSyncMock.mockReturnValueOnce(undefined)

    addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')

    expect(gitExecFileSyncMock.mock.calls).toEqual([
      [['worktree', 'add', '-b', 'feature/test', '/repo-feature', 'origin/main'], { cwd: '/repo' }]
    ])
  })

  it('fast-forwards with reset --hard when localBranch is checked out in primary worktree', () => {
    const worktreeListOutput =
      'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-other\nHEAD def456\nbranch refs/heads/feature\n'
    gitExecFileSyncMock
      .mockReturnValueOnce('') // merge-base --is-ancestor
      .mockReturnValueOnce(worktreeListOutput) // worktree list --porcelain
      .mockReturnValueOnce('') // status --porcelain (in /repo)
      .mockReturnValueOnce(undefined) // reset --hard (in /repo)
      .mockReturnValueOnce(undefined) // worktree add

    addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(gitExecFileSyncMock.mock.calls).toEqual([
      [['merge-base', '--is-ancestor', 'main', 'origin/main'], { cwd: '/repo' }],
      [['worktree', 'list', '--porcelain'], { cwd: '/repo' }],
      [['status', '--porcelain', '--untracked-files=no'], { cwd: '/repo' }],
      [['reset', '--hard', 'origin/main'], { cwd: '/repo' }],
      [['worktree', 'add', '-b', 'feature/test', '/repo-feature', 'origin/main'], { cwd: '/repo' }]
    ])
  })

  it('fast-forwards with reset --hard in sibling worktree when localBranch is checked out there', () => {
    const worktreeListOutput =
      'worktree /repo\nHEAD abc123\nbranch refs/heads/develop\n\nworktree /repo-main-wt\nHEAD def456\nbranch refs/heads/main\n'
    gitExecFileSyncMock
      .mockReturnValueOnce('') // merge-base --is-ancestor
      .mockReturnValueOnce(worktreeListOutput) // worktree list --porcelain
      .mockReturnValueOnce('') // status --porcelain (in /repo-main-wt)
      .mockReturnValueOnce(undefined) // reset --hard (in /repo-main-wt)
      .mockReturnValueOnce(undefined) // worktree add

    addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(gitExecFileSyncMock.mock.calls[2]).toEqual([
      ['status', '--porcelain', '--untracked-files=no'],
      expect.objectContaining({ cwd: '/repo-main-wt' })
    ])
    expect(gitExecFileSyncMock.mock.calls[3]).toEqual([
      ['reset', '--hard', 'origin/main'],
      expect.objectContaining({ cwd: '/repo-main-wt' })
    ])
  })

  it('uses update-ref when localBranch is not checked out in any worktree', () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/develop\n'
    gitExecFileSyncMock
      .mockReturnValueOnce('') // merge-base --is-ancestor
      .mockReturnValueOnce(worktreeListOutput) // worktree list --porcelain
      .mockReturnValueOnce(undefined) // update-ref
      .mockReturnValueOnce(undefined) // worktree add

    addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(gitExecFileSyncMock.mock.calls[2]).toEqual([
      ['update-ref', 'refs/heads/main', 'origin/main'],
      expect.objectContaining({ cwd: '/repo' })
    ])
  })

  it('skips update when the owning worktree is dirty', () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileSyncMock
      .mockReturnValueOnce('') // merge-base --is-ancestor
      .mockReturnValueOnce(worktreeListOutput) // worktree list --porcelain
      .mockReturnValueOnce(' M package.json\n') // status --porcelain (dirty)
      .mockReturnValueOnce(undefined) // worktree add

    addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    // No reset --hard or update-ref — just merge-base, worktree list, status, worktree add
    expect(gitExecFileSyncMock.mock.calls).toHaveLength(4)
    expect(gitExecFileSyncMock.mock.calls[3]?.[0]).toEqual([
      'worktree',
      'add',
      '-b',
      'feature/test',
      '/repo-feature',
      'origin/main'
    ])
  })

  it('skips updating the local branch when it has diverged', () => {
    gitExecFileSyncMock.mockImplementationOnce(() => {
      throw new Error('not a fast-forward')
    })
    gitExecFileSyncMock.mockReturnValueOnce(undefined)

    addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(gitExecFileSyncMock.mock.calls).toEqual([
      [
        ['merge-base', '--is-ancestor', 'main', 'origin/main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['worktree', 'add', '-b', 'feature/test', '/repo-feature', 'origin/main'],
        expect.objectContaining({ cwd: '/repo' })
      ]
    ])
  })

  it('uses the remote name from the base ref instead of hardcoding origin', () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileSyncMock
      .mockReturnValueOnce('') // merge-base --is-ancestor
      .mockReturnValueOnce(worktreeListOutput) // worktree list --porcelain
      .mockReturnValueOnce('') // status --porcelain
      .mockReturnValueOnce(undefined) // reset --hard
      .mockReturnValueOnce(undefined) // worktree add

    addWorktree('/repo', '/repo-feature', 'feature/test', 'upstream/main', true)

    expect(gitExecFileSyncMock.mock.calls[0]?.[0]).toEqual([
      'merge-base',
      '--is-ancestor',
      'main',
      'upstream/main'
    ])
    expect(gitExecFileSyncMock.mock.calls[3]?.[0]).toEqual(['reset', '--hard', 'upstream/main'])
  })
})
