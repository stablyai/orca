import { beforeEach, expect, it, vi } from 'vitest'
import { buildSearchBaseRefsArgv } from './repo-ref-search-command'
import { searchRemoteRefPage } from './repo-remote-ref-search'
import { gitExecFileAsync } from './runner'
import { clearGitCapabilityStateForTests } from './command-runner/git-capability-state'
vi.mock('./runner', () => ({ gitExecFileAsync: vi.fn() }))
beforeEach(() => {
  vi.mocked(gitExecFileAsync).mockReset()
  clearGitCapabilityStateForTests()
})
it('applies the remote namespace before both modern and legacy candidate caps', () => {
  for (const excludeRemoteHead of [true, false]) {
    const args = buildSearchBaseRefsArgv('topic', 51, { namespace: 'remote', excludeRemoteHead })
    expect(args.filter((arg) => arg.startsWith('refs/'))).toEqual([
      'refs/remotes/**/*topic*',
      'refs/remotes/**/*topic*/**'
    ])
    expect(args).toContain(excludeRemoteHead ? '--count=204' : '--count=304')
  }
})
it.each([0, 1])(
  'propagates failure from read %i rather than returning empty discovery',
  async (read) => {
    const failure = new Error('read failed')
    if (read === 1) {
      vi.mocked(gitExecFileAsync).mockResolvedValueOnce({ stdout: 'origin\n', stderr: '' })
    }
    vi.mocked(gitExecFileAsync).mockRejectedValueOnce(failure)
    await expect(searchRemoteRefPage('/repo', 'topic', 50)).rejects.toBe(failure)
  }
)
it('uses a sentinel and reports a saturated scan even after HEAD filtering', async () => {
  vi.mocked(gitExecFileAsync)
    .mockResolvedValueOnce({ stdout: 'origin\n', stderr: '' })
    .mockResolvedValueOnce({
      stdout: Array.from({ length: 204 }, () => 'refs/remotes/origin/HEAD\0origin/HEAD').join('\n'),
      stderr: ''
    })
  expect(await searchRemoteRefPage('/repo', '', 50)).toEqual({ refDetails: [], truncated: true })
})
it.each([100, 1000])(
  'retains only the requested 50 remote rows from %i candidates',
  async (size) => {
    vi.mocked(gitExecFileAsync)
      .mockResolvedValueOnce({ stdout: 'origin\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: Array.from(
          { length: size },
          (_, n) => `refs/remotes/origin/topic-${n}\0origin/topic-${n}`
        ).join('\n'),
        stderr: ''
      })
    const page = await searchRemoteRefPage('/repo', 'topic', 50)
    expect(page.refDetails).toHaveLength(50)
    expect(page.truncated).toBe(true)
    // The caller needs 50 choices plus a sentinel; Git bounds candidates before returning them.
    expect(vi.mocked(gitExecFileAsync).mock.calls[1]?.[0]).toContain('--count=204')
    expect(gitExecFileAsync).toHaveBeenCalledTimes(2)
  }
)
