import { beforeEach, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './runner'
import { listLocalBranches } from './checkout'
vi.mock('./runner', () => ({ gitExecFileAsync: vi.fn() }))
vi.mock('./source-control/git-read-cache-invalidation', () => ({
  runWithGitReadCacheInvalidation: vi.fn()
}))
beforeEach(() => vi.mocked(gitExecFileAsync).mockReset())
it.each(['unknown field: worktreepath', 'format failed on this host'])(
  'retries the original listing once after %s',
  async (message) => {
    vi.mocked(gitExecFileAsync)
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValueOnce({ stdout: '*\tmain\n \tfeature\n', stderr: '' })
    expect(await listLocalBranches('/repo')).toEqual({
      current: 'main',
      branches: ['main', 'feature']
    })
    expect(vi.mocked(gitExecFileAsync).mock.calls[1]?.[0]).toEqual([
      'for-each-ref',
      '--format=%(HEAD)%09%(refname:lstrip=2)',
      'refs/heads/'
    ])
    expect(gitExecFileAsync).toHaveBeenCalledTimes(2)
  }
)
it('propagates the retry error without a third attempt', async () => {
  const failure = new Error('repository unreadable')
  vi.mocked(gitExecFileAsync)
    .mockRejectedValueOnce(new Error('first'))
    .mockRejectedValueOnce(failure)
  await expect(listLocalBranches('/repo')).rejects.toBe(failure)
  expect(gitExecFileAsync).toHaveBeenCalledTimes(2)
})
it('does not retry cancellation', async () => {
  const abort = new Error('cancelled')
  abort.name = 'AbortError'
  vi.mocked(gitExecFileAsync).mockRejectedValueOnce(abort)
  await expect(listLocalBranches('/repo')).rejects.toBe(abort)
  expect(gitExecFileAsync).toHaveBeenCalledOnce()
})

it('translates occupied WSL branches into the owning workspace path namespace', async () => {
  const platform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    vi.mocked(gitExecFileAsync).mockResolvedValueOnce({
      stdout: ' \tfeature\t1700000000\t/home/alice/feature\n',
      stderr: ''
    })
    const result = await listLocalBranches(String.raw`\\wsl.localhost\Ubuntu\home\alice\repo`)
    expect(result.worktreePaths).toEqual({
      feature: String.raw`\\wsl.localhost\Ubuntu\home\alice\feature`
    })
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  }
})
