import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({ gitExecFileAsyncMock: vi.fn() }))
vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
import { getUpstreamStatus, invalidateGitUpstreamStatusReads } from './upstream'

describe('explicit publish target status', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    invalidateGitUpstreamStatusReads()
  })
  it('uses an explicit publish target instead of the configured upstream', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '+refs/heads/*:refs/remotes/fork/*\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '1\t2\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '+ def456 remote work\n', stderr: '' })

    const result = await getUpstreamStatus('/repo', {
      remoteName: 'fork',
      branchName: 'feature/fix'
    })

    expect(result).toMatchObject({
      hasUpstream: true,
      upstreamName: 'fork/feature/fix',
      ahead: 1,
      behind: 2,
      behindCommitsArePatchEquivalent: false
    })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['check-ref-format', '--branch', 'feature/fix'], { cwd: '/repo' }],
      [['config', '--get-all', 'remote.fork.fetch'], { cwd: '/repo' }],
      [['rev-parse', '--verify', '--quiet', 'refs/remotes/fork/feature/fix'], { cwd: '/repo' }],
      [
        ['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/fork/feature/fix'],
        { cwd: '/repo' }
      ],
      [
        [
          'log',
          '--oneline',
          '--cherry-mark',
          '--right-only',
          'HEAD...refs/remotes/fork/feature/fix',
          '--'
        ],
        { cwd: '/repo' }
      ]
    ])
  })

  it('routes explicit publish-target probes through the selected WSL distro', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '+refs/heads/*:refs/remotes/fork/*\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '0\t0\n', stderr: '' })

    await expect(
      getUpstreamStatus(
        '/repo',
        {
          remoteName: 'fork',
          branchName: 'feature/fix'
        },
        { wslDistro: 'Ubuntu' }
      )
    ).resolves.toMatchObject({
      hasUpstream: true,
      upstreamName: 'fork/feature/fix',
      ahead: 0,
      behind: 0
    })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['check-ref-format', '--branch', 'feature/fix'], { cwd: '/repo', wslDistro: 'Ubuntu' }],
      [['config', '--get-all', 'remote.fork.fetch'], { cwd: '/repo', wslDistro: 'Ubuntu' }],
      [
        ['rev-parse', '--verify', '--quiet', 'refs/remotes/fork/feature/fix'],
        { cwd: '/repo', wslDistro: 'Ubuntu' }
      ],
      [
        ['rev-list', '--left-right', '--count', 'HEAD...refs/remotes/fork/feature/fix'],
        { cwd: '/repo', wslDistro: 'Ubuntu' }
      ]
    ])
  })

  it('reports no upstream when an explicit publish target has not been fetched yet', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: '+refs/heads/*:refs/remotes/fork/*\n', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('git exited with 1.'), { stderr: '' }))

    await expect(
      getUpstreamStatus('/repo', {
        remoteName: 'fork',
        branchName: 'feature/fix'
      })
    ).resolves.toMatchObject({
      hasUpstream: false,
      upstreamName: 'fork/feature/fix',
      ahead: 0,
      behind: 0,
      hasConfiguredPushTarget: true
    })
  })

  it('does not hide git failures while checking an explicit publish target', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' }).mockRejectedValueOnce(
      Object.assign(new Error('fatal: not a git repository'), {
        stderr: 'fatal: not a git repository'
      })
    )

    await expect(
      getUpstreamStatus('/repo', {
        remoteName: 'fork',
        branchName: 'feature/fix'
      })
    ).rejects.toThrow('fatal: not a git repository')
  })
})
