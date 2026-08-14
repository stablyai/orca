import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from './runner'

const { gitExecFileAsyncMock, gitExecFileSyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn()
}))

vi.mock('./runner', async (importOriginal) => {
  const actual = await importOriginal<typeof GitRunner>()
  return {
    ...actual,
    gitExecFileAsync: gitExecFileAsyncMock,
    gitExecFileSync: gitExecFileSyncMock
  }
})

import { getRecentDriftSubjects, getRemoteDrift } from './repo'

describe('remote drift Git probes', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileSyncMock.mockReset()
  })

  it('parses drift asynchronously with the existing timeout and WSL routing', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: '3\t4\n', stderr: '' })

    await expect(
      getRemoteDrift('C:\\repo', 'HEAD', 'origin/main', { wslDistro: 'Ubuntu' })
    ).resolves.toEqual({ ahead: 3, behind: 4 })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-list', '--left-right', '--count', 'HEAD...origin/main'],
      { cwd: 'C:\\repo', wslDistro: 'Ubuntu', timeout: 15_000 }
    )
    expect(gitExecFileSyncMock).not.toHaveBeenCalled()
  })

  it('keeps malformed output and Git failures unknown', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'invalid\n', stderr: '' })
    await expect(getRemoteDrift('/repo', 'HEAD', 'origin/main')).resolves.toBeNull()

    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('git failed'))
    await expect(getRemoteDrift('/repo', 'HEAD', 'origin/main')).resolves.toBeNull()
  })

  it('preserves subject order and degrades a log failure to an empty list', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'newest subject\n\nolder subject\n',
      stderr: ''
    })
    await expect(getRecentDriftSubjects('/repo', 'HEAD', 'origin/main', 5)).resolves.toEqual([
      'newest subject',
      'older subject'
    ])
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['log', '--format=%s', '-n', '5', 'HEAD..origin/main'],
      { cwd: '/repo', timeout: 15_000 }
    )

    gitExecFileAsyncMock.mockRejectedValueOnce(new Error('git failed'))
    await expect(getRecentDriftSubjects('/repo', 'HEAD', 'origin/main', 5)).resolves.toEqual([])
  })
})
