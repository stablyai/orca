import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { gitExecFileAsync } from '../../command-runner/git-exec-file'

const { gitExec } = vi.hoisted(() => ({ gitExec: vi.fn<typeof gitExecFileAsync>() }))

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExec
}))

import { clearGitCapabilityStateForTests } from '../../command-runner/git-capability-state'
import { readWorktreeList } from './worktree-list-reader'

const originalPlatform = process.platform

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

beforeEach(() => {
  clearGitCapabilityStateForTests()
  gitExec.mockReset()
  gitExec.mockResolvedValue({
    stdout: `worktree /repo\0HEAD ${'a'.repeat(40)}\0branch refs/heads/main\0\0`,
    stderr: ''
  })
})

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('worktree list process creation', () => {
  it('spawns on the process worker on Windows', async () => {
    setPlatform('win32')
    await readWorktreeList('/repo')
    expect(gitExec).toHaveBeenCalledWith(
      ['worktree', 'list', '--porcelain', '-z'],
      expect.objectContaining({ spawnOnWorkerThread: true })
    )
  })

  it('keeps an explicit caller choice', async () => {
    setPlatform('win32')
    await readWorktreeList('/repo', { spawnOnWorkerThread: false })
    expect(gitExec).toHaveBeenCalledWith(
      ['worktree', 'list', '--porcelain', '-z'],
      expect.objectContaining({ spawnOnWorkerThread: false })
    )
  })

  it.each(['linux', 'darwin'] as const)('leaves %s on the calling loop', async (platform) => {
    setPlatform(platform)
    await readWorktreeList('/repo')
    expect(gitExec.mock.calls[0]?.[1]).not.toHaveProperty('spawnOnWorkerThread')
  })
})
