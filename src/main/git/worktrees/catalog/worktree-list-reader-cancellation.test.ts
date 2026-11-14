import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as FsPromises from 'node:fs/promises'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { gitExecFileAsync } from '../../command-runner/git-exec-file'

const { statProbe, gitExec } = vi.hoisted(() => ({
  statProbe: vi.fn<(worktreePath: string) => Promise<void>>(),
  gitExec: vi.fn<typeof gitExecFileAsync>()
}))

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof FsPromises>()),
  stat: statProbe
}))
vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExec
}))

vi.mock('../../command-runner/host-routing/wsl-path-translation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  translateWslOutputPaths: (output: string) => output
}))
vi.mock('../../../../shared/git/worktrees/git-worktree-admin', () => ({
  annotateWorktreeLocksFromAdmin: async (_repoPath: string, rows: GitWorktreeInfo[]) => rows
}))

import { clearGitCapabilityStateForTests } from '../../command-runner/host-routing/git-capability-state'
import { readWorktreeList } from './worktree-list-reader'

function porcelainRow(worktreePath: string, markers: string[] = []): string {
  return [
    `worktree ${worktreePath}`,
    `HEAD ${'a'.repeat(40)}`,
    'branch refs/heads/main',
    ...markers,
    '',
    ''
  ].join('\n')
}

let porcelain = ''
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

beforeEach(() => {
  clearGitCapabilityStateForTests()
  statProbe.mockReset()
  gitExec.mockReset()
  porcelain =
    porcelainRow('/repo') +
    Array.from({ length: 32 }, (_, index) => porcelainRow(`/repo/task-${index}`)).join('')
  gitExec.mockImplementation(async (args) => {
    if (args.includes('-z')) {
      throw Object.assign(new Error("unknown switch `z'"), { stderr: "error: unknown switch `z'" })
    }
    return { stdout: porcelain, stderr: '' }
  })
})

describe('old-Git native worktree listing cancellation', () => {
  it('rejects before pending existence probes finish and prevents further probes', async () => {
    const controller = new AbortController()
    const reason = new Error('Listing closed')
    const releases: (() => void)[] = []
    statProbe.mockImplementation(() => new Promise((resolve) => releases.push(resolve)))
    const outcome = vi.fn<(result: unknown) => void>()
    const observed = readWorktreeList('/repo', { signal: controller.signal }).then(
      (result) => outcome(result),
      (error: unknown) => outcome(error)
    )
    try {
      await nextTurn()
      expect(gitExec.mock.calls.map(([args]) => args)).toEqual([
        ['worktree', 'list', '--porcelain', '-z'],
        ['worktree', 'list', '--porcelain']
      ])
      expect(statProbe).toHaveBeenCalledTimes(8)
      controller.abort(reason)
      await nextTurn()
      expect(outcome).toHaveBeenCalledExactlyOnceWith(reason)
      expect(statProbe).toHaveBeenCalledTimes(8)
    } finally {
      releases.splice(0).forEach((release) => release())
    }
    await observed
    await nextTurn()
    expect(outcome).toHaveBeenCalledExactlyOnceWith(reason)
    expect(statProbe).toHaveBeenCalledTimes(8)
  })

  it('handles synchronous cancellation by the first existence probe without an unhandled rejection', async () => {
    const controller = new AbortController()
    const reason = new Error('First probe closed the request')
    const releases: (() => void)[] = []
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => {
      unhandled.push(error)
    }
    process.on('unhandledRejection', onUnhandled)
    statProbe.mockImplementation(() => {
      controller.abort(reason)
      return new Promise((resolve) => releases.push(resolve))
    })
    try {
      await expect(readWorktreeList('/repo', { signal: controller.signal })).rejects.toBe(reason)
      expect(statProbe).toHaveBeenCalledTimes(1)
      releases.splice(0).forEach((release) => release())
      await nextTurn()
      expect(statProbe).toHaveBeenCalledTimes(1)
      expect(unhandled).toEqual([])
    } finally {
      releases.splice(0).forEach((release) => release())
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
