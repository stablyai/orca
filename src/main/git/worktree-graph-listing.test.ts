// listWorktreeGraph: -z porcelain listing plus the older-Git usage-error fallback.
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { listWorktreeGraph, WORKTREE_LIST_TIMEOUT_MS } from './worktree'
import { registerWorktreeSuiteHooks } from './worktree-test-harness'

registerWorktreeSuiteHooks()

describe('listWorktreeGraph', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
  })

  it('returns the worktree graph without sparse-checkout annotation probes', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
    })

    await expect(listWorktreeGraph('/repo')).resolves.toEqual([
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
      }
    ])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-z'], {
      cwd: '/repo',
      timeout: WORKTREE_LIST_TIMEOUT_MS
    })
  })

  it('falls back when older Git rejects worktree list -z with usage exit code', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(
        Object.assign(new Error('git usage error'), {
          code: 129,
          stderr: 'usage: git worktree list [<options>]\n'
        })
      )
      .mockResolvedValueOnce({
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-main-2
HEAD def456
branch refs/heads/main-2
`
      })

    await expect(listWorktreeGraph('/repo')).resolves.toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      },
      {
        path: '/repo-main-2',
        head: 'def456',
        branch: 'refs/heads/main-2',
        isBare: false,
        isMainWorktree: false,
        // The line-block fallback also probes linked worktree paths for
        // existence (issue #8389), and this mocked path is absent on disk.
        prunable: true
      }
    ])

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'list', '--porcelain', '-z'],
        { cwd: '/repo', timeout: WORKTREE_LIST_TIMEOUT_MS }
      ],
      [['worktree', 'list', '--porcelain'], { cwd: '/repo', timeout: WORKTREE_LIST_TIMEOUT_MS }]
    ])
  })

  it('falls back on a localized (non-English) older-Git usage error via exit code 129', async () => {
    // Git under a non-English locale translates the usage text, so stderr
    // matching alone misses it; the 129 exit code must still trigger fallback.
    gitExecFileAsyncMock
      .mockRejectedValueOnce(
        Object.assign(new Error('git worktree list --porcelain -z'), {
          code: 129,
          stderr: 'Fehler: Unbekannter Schalter »z«\nAufruf: git worktree list [<Optionen>]\n'
        })
      )
      .mockResolvedValueOnce({
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      })

    await expect(listWorktreeGraph('/repo')).resolves.toEqual([
      {
        path: '/repo',
        head: 'abc123',
        branch: 'refs/heads/main',
        isBare: false,
        isMainWorktree: true
      }
    ])

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'list', '--porcelain', '-z'],
        { cwd: '/repo', timeout: WORKTREE_LIST_TIMEOUT_MS }
      ],
      [['worktree', 'list', '--porcelain'], { cwd: '/repo', timeout: WORKTREE_LIST_TIMEOUT_MS }]
    ])
  })

  it('does not retry without -z for non-usage Git failures', async () => {
    // A fatal error (exit 128) is not an unsupported-flag signal, so the -z
    // command must not be silently re-run without it.
    gitExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('git worktree list --porcelain -z'), {
        code: 128,
        stderr: 'fatal: unable to read tree\n'
      })
    )

    await expect(listWorktreeGraph('/repo')).resolves.toEqual([])

    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [
        ['worktree', 'list', '--porcelain', '-z'],
        { cwd: '/repo', timeout: WORKTREE_LIST_TIMEOUT_MS }
      ]
    ])
  })

  it('returns an empty graph for paths Git reports as non-repositories', async () => {
    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('fatal: not a git repository'))

    await expect(listWorktreeGraph('/not-a-repo')).resolves.toEqual([])
  })

  it('lets callers override the default worktree list timeout', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n'
    })

    await listWorktreeGraph('/repo', { timeout: 5_000 })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['worktree', 'list', '--porcelain', '-z'], {
      cwd: '/repo',
      timeout: 5_000
    })
    expect(WORKTREE_LIST_TIMEOUT_MS).toBe(30_000)
  })
})
