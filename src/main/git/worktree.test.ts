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
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
  })

  it('creates the worktree without touching the local base ref by default', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'add', '--no-track', '-b', 'feature/test', '/repo-feature', 'origin/main'],
        { cwd: '/repo' }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }],
      [['config', '--local', 'push.autoSetupRemote', 'true'], { cwd: '/repo-feature' }]
    ])
  })

  it('warns but does not throw when push.autoSetupRemote config fails', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get (unset, expected)
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('config locked')) // config --local set fails
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')
    ).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledWith(
      'addWorktree: failed to set push.autoSetupRemote for /repo-feature',
      expect.any(Error)
    )
    warnSpy.mockRestore()
  })

  it('warns and skips --local set when --get fails with non-unset error (e.g. corrupt config)', async () => {
    // Why: exit 1 from `git config --get` means "key unset" — anything else
    // is a real read failure (parse error, locked file). We must NOT fall
    // through to `--local set true`, which would silently overwrite whatever
    // value the user actually has.
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('parse error'), { code: 3 })) // --get fails non-unset
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')
    ).resolves.toBeUndefined()

    expect(warnSpy).toHaveBeenCalledWith(
      'addWorktree: failed to set push.autoSetupRemote for /repo-feature',
      expect.any(Error)
    )
    // No --local set was attempted: only worktree add + the failing --get.
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'add', '--no-track', '-b', 'feature/test', '/repo-feature', 'origin/main'],
        { cwd: '/repo' }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }]
    ])
    warnSpy.mockRestore()
  })

  it('preserves existing push.autoSetupRemote value (does not overwrite user-set false)', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'false\n' }) // config --get returns existing value

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')

    // No --local set: --get succeeded so we preserve the user's value.
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'add', '--no-track', '-b', 'feature/test', '/repo-feature', 'origin/main'],
        { cwd: '/repo' }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }]
    ])
  })

  it('treats --get success with empty stdout as "already set" (key present but blank)', async () => {
    // Why: `git config --get key` exits 0 if the key has any value at any
    // scope, including the unusual case of an explicitly empty string. We
    // must not fall through to `--local set true` and overwrite that.
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --get succeeds with empty value

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'add', '--no-track', '-b', 'feature/test', '/repo-feature', 'origin/main'],
        { cwd: '/repo' }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }]
    ])
  })

  it('does not probe or write config when worktree add itself fails', async () => {
    // Why: a refactor that moves the config block earlier could try to write
    // push.autoSetupRemote against a worktree directory that was never
    // created. Pin the current ordering invariant: config calls happen only
    // after worktree add succeeds.
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('worktree add failed'))

    await expect(
      addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main')
    ).rejects.toThrow('worktree add failed')

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'add', '--no-track', '-b', 'feature/test', '/repo-feature', 'origin/main'],
        { cwd: '/repo' }
      ]
    ])
  })

  it('fast-forwards with reset --hard when localBranch is checked out in primary worktree', async () => {
    const worktreeListOutput =
      'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-other\nHEAD def456\nbranch refs/heads/feature\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' }) // merge-base --is-ancestor
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain (in /repo)
      .mockResolvedValueOnce({ stdout: '' }) // reset --hard (in /repo)
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['merge-base', '--is-ancestor', 'main', 'origin/main'], { cwd: '/repo' }],
      [['worktree', 'list', '--porcelain'], { cwd: '/repo' }],
      [['status', '--porcelain', '--untracked-files=no'], { cwd: '/repo' }],
      [['reset', '--hard', 'origin/main'], { cwd: '/repo' }],
      [
        ['worktree', 'add', '--no-track', '-b', 'feature/test', '/repo-feature', 'origin/main'],
        { cwd: '/repo' }
      ],
      [['config', '--get', 'push.autoSetupRemote'], { cwd: '/repo-feature' }],
      [['config', '--local', 'push.autoSetupRemote', 'true'], { cwd: '/repo-feature' }]
    ])
  })

  it('fast-forwards with reset --hard in sibling worktree when localBranch is checked out there', async () => {
    const worktreeListOutput =
      'worktree /repo\nHEAD abc123\nbranch refs/heads/develop\n\nworktree /repo-main-wt\nHEAD def456\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' }) // merge-base --is-ancestor
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain (in /repo-main-wt)
      .mockResolvedValueOnce({ stdout: '' }) // reset --hard (in /repo-main-wt)
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(gitExecFileAsyncMock.mock.calls[2]).toEqual([
      ['status', '--porcelain', '--untracked-files=no'],
      expect.objectContaining({ cwd: '/repo-main-wt' })
    ])
    expect(gitExecFileAsyncMock.mock.calls[3]).toEqual([
      ['reset', '--hard', 'origin/main'],
      expect.objectContaining({ cwd: '/repo-main-wt' })
    ])
  })

  it('uses update-ref when localBranch is not checked out in any worktree', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/develop\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' }) // merge-base --is-ancestor
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // update-ref
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(gitExecFileAsyncMock.mock.calls[2]).toEqual([
      ['update-ref', 'refs/heads/main', 'origin/main'],
      expect.objectContaining({ cwd: '/repo' })
    ])
  })

  it('skips update when the owning worktree is dirty', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' }) // merge-base --is-ancestor
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: ' M package.json\n' }) // status --porcelain (dirty)
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    // No reset --hard or update-ref — just merge-base, worktree list, status, worktree add, config --get, config --local set
    expect(gitExecFileAsyncMock.mock.calls).toHaveLength(6)
    expect(gitExecFileAsyncMock.mock.calls[3]?.[0]).toEqual([
      'worktree',
      'add',
      '--no-track',
      '-b',
      'feature/test',
      '/repo-feature',
      'origin/main'
    ])
    expect(gitExecFileAsyncMock.mock.calls[4]?.[0]).toEqual([
      'config',
      '--get',
      'push.autoSetupRemote'
    ])
    expect(gitExecFileAsyncMock.mock.calls[5]?.[0]).toEqual([
      'config',
      '--local',
      'push.autoSetupRemote',
      'true'
    ])
  })

  it('skips updating the local branch when it has diverged', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('not a fast-forward'))
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // worktree add
    gitExecFileAsyncMock.mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['merge-base', '--is-ancestor', 'main', 'origin/main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['worktree', 'add', '--no-track', '-b', 'feature/test', '/repo-feature', 'origin/main'],
        expect.objectContaining({ cwd: '/repo' })
      ],
      [
        ['config', '--get', 'push.autoSetupRemote'],
        expect.objectContaining({ cwd: '/repo-feature' })
      ],
      [
        ['config', '--local', 'push.autoSetupRemote', 'true'],
        expect.objectContaining({ cwd: '/repo-feature' })
      ]
    ])
  })

  it('uses the remote name from the base ref instead of hardcoding origin', async () => {
    const worktreeListOutput = 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' }) // merge-base --is-ancestor
      .mockResolvedValueOnce({ stdout: worktreeListOutput }) // worktree list --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // status --porcelain
      .mockResolvedValueOnce({ stdout: '' }) // reset --hard
      .mockResolvedValueOnce({ stdout: '' }) // worktree add
      .mockRejectedValueOnce(Object.assign(new Error('key unset'), { code: 1 })) // config --get push.autoSetupRemote (unset)
      .mockResolvedValueOnce({ stdout: '' }) // config --local set push.autoSetupRemote

    await addWorktree('/repo', '/repo-feature', 'feature/test', 'upstream/main', true)

    expect(gitExecFileAsyncMock.mock.calls[0]?.[0]).toEqual([
      'merge-base',
      '--is-ancestor',
      'main',
      'upstream/main'
    ])
    expect(gitExecFileAsyncMock.mock.calls[3]?.[0]).toEqual(['reset', '--hard', 'upstream/main'])
  })
})
