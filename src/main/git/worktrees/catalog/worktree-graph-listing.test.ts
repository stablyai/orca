import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, gitExecFileSyncMock, translateWslOutputPathsMock } = vi.hoisted(
  () => ({
    gitExecFileAsyncMock: vi.fn(),
    gitExecFileSyncMock: vi.fn(),
    translateWslOutputPathsMock: vi.fn((output: string) => output)
  })
)

vi.mock('../../../../shared/git/worktrees/git-worktree-admin', () => ({
  annotateWorktreeLocksFromAdmin: async (_repoPath: string, rows: unknown[]) => rows
}))

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../../command-runner/git-exec-file-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileSync: gitExecFileSyncMock
}))

vi.mock('../../command-runner/host-routing/wsl-path-translation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  translateWslOutputPaths: translateWslOutputPathsMock
}))

import { listWorktreeGraph } from './worktree-scan-cache'
import { WORKTREE_LIST_TIMEOUT_MS } from '../worktree-operation-options'
import { registerWorktreeSuiteHooks } from '../testing/worktree-test-harness'

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
})
