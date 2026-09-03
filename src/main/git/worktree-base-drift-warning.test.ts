import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { getLocalBaseRefDriftWarningForWorktreeCreate } from './worktree-base-refresh-analysis'

describe('getLocalBaseRefDriftWarningForWorktreeCreate', () => {
  beforeEach(() => gitExecFileAsyncMock.mockReset())

  const mockLocalRefAndCount = (count: string): void => {
    gitExecFileAsyncMock.mockImplementation(async (args: string[] | undefined) =>
      args?.[0] === 'rev-list'
        ? { stdout: count }
        : args?.[3]?.startsWith('refs/remotes/')
          ? { stdout: '' }
          : { stdout: 'local-sha\n' }
    )
  }

  it('reports a local base that is behind the detected default', async () => {
    mockLocalRefAndCount('0\t692\n')

    await expect(
      getLocalBaseRefDriftWarningForWorktreeCreate('/repo', 'work/stale', 'origin/main')
    ).resolves.toEqual({
      baseRef: 'work/stale',
      defaultBaseRef: 'origin/main',
      ahead: 0,
      behind: 692,
      relation: 'behind'
    })
  })

  it('reports a diverged local base', async () => {
    mockLocalRefAndCount('2\t5\n')

    await expect(
      getLocalBaseRefDriftWarningForWorktreeCreate('/repo', 'work/topic', 'origin/main')
    ).resolves.toMatchObject({ ahead: 2, behind: 5, relation: 'diverged' })
  })

  it('does not warn for an ahead-only or current base', async () => {
    mockLocalRefAndCount('2\t0\n')
    await expect(
      getLocalBaseRefDriftWarningForWorktreeCreate('/repo', 'work/ahead', 'origin/main')
    ).resolves.toBeUndefined()

    mockLocalRefAndCount('0\t0\n')
    await expect(
      getLocalBaseRefDriftWarningForWorktreeCreate('/repo', 'work/current', 'origin/main')
    ).resolves.toBeUndefined()
  })

  it('ignores remote-tracking pins and invalid probe results', async () => {
    await expect(
      getLocalBaseRefDriftWarningForWorktreeCreate(
        '/repo',
        'refs/remotes/origin/main',
        'origin/main'
      )
    ).resolves.toBeUndefined()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    await expect(
      getLocalBaseRefDriftWarningForWorktreeCreate('/repo', 'refs/tags/v1', 'origin/main')
    ).resolves.toBeUndefined()
    await expect(
      getLocalBaseRefDriftWarningForWorktreeCreate('/repo', 'a'.repeat(40), 'origin/main')
    ).resolves.toBeUndefined()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()

    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'remote-sha\n' })
    await expect(
      getLocalBaseRefDriftWarningForWorktreeCreate('/repo', 'origin/release', 'origin/main')
    ).resolves.toBeUndefined()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)

    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'not-a-count' })
    await expect(
      getLocalBaseRefDriftWarningForWorktreeCreate('/repo', 'work/stale', 'origin/main')
    ).resolves.toBeUndefined()
  })
})
