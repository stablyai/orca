import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, gitExecFileSyncMock, translateWslOutputPathsMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileSyncMock: vi.fn(),
    translateWslOutputPathsMock: vi.fn((output: string) => output)
  })
)

vi.mock('../../shared/git-worktree-admin', () => ({
  annotateWorktreeLocksFromAdmin: async (_repoPath: string, rows: unknown[]) => rows
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: gitExecFileSyncMock,
  translateWslOutputPaths: translateWslOutputPathsMock
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

  it('falls back on a localized (non-English) older-Git usage error via exit code 129', async () => {
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
})
