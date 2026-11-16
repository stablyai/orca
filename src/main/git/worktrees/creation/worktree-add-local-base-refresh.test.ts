import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  refreshGitMock,
  checkoutGitMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  refreshGitMock: vi.fn(),
  checkoutGitMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output)
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

// The detached checkout fast-forward would drain later tests' queues; real-Git tests cover it.
vi.mock('./worktree-base-refresh', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fastForwardCheckedOutLocalBaseAfterCreate: vi.fn()
}))

// Keep the ordered runner queues; worktree-checkout-progress-real-git covers the checkout.workers read.
vi.mock('./checkout-workers-git-args', () => ({
  checkoutWorkersGitArgs: async () => []
}))

import { addWorktree } from './worktree-add'
import { registerWorktreeSuiteHooks } from '../testing/worktree-test-harness'

registerWorktreeSuiteHooks()

// A real, empty Git common dir: no rebase or bisect reserves main.
const commonDir = mkdtempSync(join(tmpdir(), 'orca-add-refresh-common-'))
afterAll(() => rmSync(commonDir, { recursive: true, force: true }))

describe('addWorktree', () => {
  afterEach(() => vi.restoreAllMocks())
  beforeEach(() => {
    // These branch-safety assertions use POSIX argv; Windows flags have separate coverage.
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    // Separate the overlapping checkout from the ordered refresh probe queue.
    refreshGitMock.mockReset()
    checkoutGitMock.mockReset().mockImplementation(async (args: string[]) => {
      if (args[0] === 'config' && args[1] === '--get') {
        throw Object.assign(new Error('key unset'), { code: 1 })
      }
      return { stdout: '' }
    })
    gitExecFileAsyncMock
      .mockReset()
      .mockImplementation(async (args: string[], opts: unknown) =>
        args[0] === 'rev-parse' && args[1] === '--git-common-dir'
          ? { stdout: `${commonDir}\n` }
          : (args[0] === 'worktree' && args[1] === 'add') ||
              args[0] === 'config' ||
              (args[0] === 'branch' && args[1] === '--set-upstream-to')
            ? checkoutGitMock(args, opts)
            : refreshGitMock(args, opts)
      )
    gitExecFileSyncMock.mockReset()
    translateWslOutputPathsMock.mockClear()
  })

  it('runs worktree add while the local base refresh is still fast-forwarding', async () => {
    let finishMove!: () => void
    let markMoveStarted!: () => void
    const moveStarted = new Promise<void>((resolve) => {
      markMoveStarted = resolve
    })
    queueBehindInspection()
      .mockResolvedValueOnce({ stdout: '' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishMove = () => resolve({ stdout: '' })
            markMoveStarted()
          })
      )
    checkoutGitMock.mockImplementationOnce(async () => {
      await moveStarted
      finishMove()
      return { stdout: '' }
    })

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'updated',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(checkoutGitMock.mock.calls[0]?.[0]).toContain('add')
  })

  it('fast-forwards local base via update-ref when localBranch is not checked out', async () => {
    queueBehindInspection()
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: '' })

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'updated',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(refreshGitMock.mock.calls.at(-1)).toEqual([
      [
        'update-ref',
        '-m',
        'orca: fast-forward to refs/remotes/origin/main',
        'refs/heads/main',
        'remote-main',
        'old-main'
      ],
      expect.objectContaining({ cwd: '/repo', beforeStart: expect.any(Function) })
    ])
  })

  it('skips local base refresh when worktree ownership cannot be listed', async () => {
    queueBehindInspection({ worktrees: new Error('worktree list failed') })

    const result = await addWorktree('/repo', '/repo-feature', 'feature/test', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_error',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    expect(refreshGitMock.mock.calls.map(([args]) => args[0])).toEqual([
      'rev-parse',
      'rev-parse',
      'rev-parse',
      'worktree'
    ])
  })

  // Creating the base's own local branch leaves nothing to refresh; probing would race the add.

  it('still suggests nothing but keeps the warning when the local base ref exists and diverged', async () => {
    queueBehindInspection({ counts: { stdout: '2\t3\n' } })

    const result = await addWorktree('/repo', '/repo-feature', 'my-feature', 'origin/main', true)

    expect(result.localBaseRefRefresh).toEqual({
      status: 'skipped_not_fast_forward',
      baseRef: 'origin/main',
      localBranch: 'main'
    })
    // The only call past the counts is the read-only shallow probe; nothing moves main.
    expect(refreshGitMock.mock.calls).toHaveLength(6)
    expect(refreshGitMock.mock.calls.at(-1)?.[0]).toEqual(['rev-parse', '--is-shallow-repository'])
  })
})

function queueBehindInspection(
  options: { worktrees?: string | Error; counts?: { stdout: string } } = {}
) {
  const worktrees = options.worktrees ?? 'worktree /repo\nHEAD abc123\nbranch refs/heads/develop\n'
  refreshGitMock
    .mockResolvedValueOnce({ stdout: 'abc123\n' })
    .mockResolvedValueOnce({ stdout: 'old-main\n' })
    .mockResolvedValueOnce({ stdout: 'remote-main\n' })
  if (worktrees instanceof Error) {
    return refreshGitMock.mockRejectedValueOnce(worktrees)
  }
  refreshGitMock.mockResolvedValueOnce({ stdout: worktrees })
  return refreshGitMock.mockResolvedValueOnce(options.counts ?? { stdout: '0\t3\n' })
}
