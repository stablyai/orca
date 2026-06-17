import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { getUpstreamStatus } from './upstream'

const missingTrackingRefError = new Error(
  "fatal: ambiguous argument 'HEAD@{u}': unknown revision or path not in the working tree.\n" +
    "Use '--' to separate paths from revisions, like this:\n" +
    "'git <command> [<revision>...] -- [<file>...]'"
)

describe('getUpstreamStatus', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('returns upstream and ahead/behind counts when tracking is configured', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'main\n' })
      .mockResolvedValueOnce({ stdout: 'origin/main\n' })
      .mockResolvedValueOnce({ stdout: '2\t3\n' })
      .mockResolvedValueOnce({ stdout: '+ abc123 remote work\n' })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 2,
      behind: 3,
      behindCommitsArePatchEquivalent: false
    })
  })

  it('marks diverged upstream commits as patch-equivalent after a rebase', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockResolvedValueOnce({ stdout: 'origin/feature\n' })
      .mockResolvedValueOnce({ stdout: '14\t3\n' })
      .mockResolvedValueOnce({
        stdout:
          '= ac503deae Stabilize pull request creation flow\n' +
          '= 7dc0fc1a6 Clean up fork PR remotes after worktree deletion\n'
      })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 14,
      behind: 3,
      behindCommitsArePatchEquivalent: true
    })
  })

  it('keeps configured local-branch upstreams', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockResolvedValueOnce({ stdout: 'main\n' })
      .mockResolvedValueOnce({ stdout: '1\t0\n' })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'main',
      ahead: 1,
      behind: 0
    })
  })

  it('returns hasUpstream=false when upstream output is empty', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockResolvedValueOnce({ stdout: '\n' })
      .mockRejectedValueOnce(new Error('missing branch remote'))
      .mockRejectedValueOnce(new Error('missing branch merge'))
      .mockRejectedValueOnce(new Error('missing branch base'))
      .mockRejectedValueOnce(new Error('missing remote branch'))

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('returns hasUpstream=false when upstream is missing', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockRejectedValueOnce(new Error('fatal: no upstream configured'))
      .mockRejectedValueOnce(new Error('missing branch remote'))
      .mockRejectedValueOnce(new Error('missing branch merge'))
      .mockRejectedValueOnce(new Error('missing branch base'))
      .mockRejectedValueOnce(new Error('missing remote branch'))

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('returns hasUpstream=false when the configured tracking ref is missing', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockRejectedValueOnce(missingTrackingRefError)
      .mockRejectedValueOnce(new Error('missing branch remote'))
      .mockRejectedValueOnce(new Error('missing branch merge'))
      .mockRejectedValueOnce(new Error('missing branch base'))
      .mockRejectedValueOnce(new Error('missing remote branch'))

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('uses the same-name origin branch when a legacy worktree tracks origin/main', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\n' })
      .mockResolvedValueOnce({ stdout: 'origin/main\n' })
      .mockResolvedValueOnce({ stdout: 'abc123\n' })
      .mockResolvedValueOnce({ stdout: '3\t1\n' })
      .mockResolvedValueOnce({ stdout: '+ def456 remote work\n' })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/feature',
      ahead: 3,
      behind: 1,
      behindCommitsArePatchEquivalent: false
    })
  })

  it('uses a named remote that matches a URL-valued branch remote', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'imp/chinese-translation\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.remote')) {
        return Promise.resolve({ stdout: 'https://github.com/pynickle/orca.git\n' })
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/imp/chinese-translation\n' })
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.base')) {
        return Promise.reject(new Error('missing branch base'))
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'origin') {
        return Promise.resolve({ stdout: 'https://github.com/stablyai/orca.git\n' })
      }
      if (args[0] === 'remote' && args[1] === 'get-url' && args[2] === 'pr-pynickle-orca') {
        return Promise.resolve({ stdout: 'https://github.com/pynickle/orca.git\n' })
      }
      if (args[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\npr-pynickle-orca\n' })
      }
      if (
        args[0] === 'rev-parse' &&
        args.includes('refs/remotes/pr-pynickle-orca/imp/chinese-translation')
      ) {
        return Promise.resolve({ stdout: 'fork-head\n' })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '2\t0\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'pr-pynickle-orca/imp/chinese-translation',
      ahead: 2,
      behind: 0
    })
  })

  it('uses a fork head branch even when its name matches the base branch', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'review/pr-1\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.remote')) {
        return Promise.resolve({ stdout: 'fork\n' })
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/main\n' })
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.base')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/fork/main')) {
        return Promise.resolve({ stdout: 'fork-head\n' })
      }
      if (args[0] === 'rev-list') {
        return Promise.resolve({ stdout: '3\t0\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'fork/main',
      ahead: 3,
      behind: 0
    })
  })

  it('marks a URL-valued branch push target when no matching remote is configured', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'imp/chinese-translation\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.pushRemote')) {
        return Promise.resolve({ stdout: 'https://github.com/pynickle/orca.git\n' })
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        return Promise.reject(new Error('missing pushDefault'))
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.remote')) {
        return Promise.resolve({ stdout: 'https://github.com/pynickle/orca.git\n' })
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/imp/chinese-translation\n' })
      }
      if (args[0] === 'config' && args.includes('branch.imp/chinese-translation.base')) {
        return Promise.reject(new Error('missing branch base'))
      }
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return Promise.resolve({ stdout: 'https://github.com/stablyai/orca.git\n' })
      }
      if (args[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/imp/chinese-translation')) {
        return Promise.reject(new Error('missing origin tracking ref'))
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      hasConfiguredPushTarget: true
    })
  })

  it('marks a fork head push target when the same-named base branch is on another remote', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'review/pr-1\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.pushRemote')) {
        return Promise.resolve({ stdout: 'fork\n' })
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        return Promise.reject(new Error('missing pushDefault'))
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.remote')) {
        return Promise.resolve({ stdout: 'fork\n' })
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/main\n' })
      }
      if (args[0] === 'config' && args.includes('branch.review/pr-1.base')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/fork/main')) {
        return Promise.reject(new Error('missing fork tracking ref'))
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/review/pr-1')) {
        return Promise.reject(new Error('missing origin review branch'))
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      hasConfiguredPushTarget: true
    })
  })

  it('does not mark origin base-branch config as a push target', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'feature\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.feature.pushRemote')) {
        return Promise.reject(new Error('missing pushRemote'))
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        return Promise.reject(new Error('missing pushDefault'))
      }
      if (args[0] === 'config' && args.includes('branch.feature.remote')) {
        return Promise.resolve({ stdout: 'origin\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/main\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature.base')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/main')) {
        return Promise.reject(new Error('missing origin/main tracking ref'))
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')) {
        return Promise.reject(new Error('missing origin/feature tracking ref'))
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('does not mark remote.pushDefault plus origin base branch as a push target', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'feature/fix\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.reject(new Error('fatal: no upstream configured'))
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.pushRemote')) {
        return Promise.reject(new Error('missing pushRemote'))
      }
      if (args[0] === 'config' && args.includes('remote.pushDefault')) {
        return Promise.resolve({ stdout: 'fork\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.remote')) {
        return Promise.resolve({ stdout: 'origin\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.merge')) {
        return Promise.resolve({ stdout: 'refs/heads/main\n' })
      }
      if (args[0] === 'config' && args.includes('branch.feature/fix.base')) {
        return Promise.resolve({ stdout: 'refs/remotes/origin/main\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature/fix')) {
        return Promise.reject(new Error('missing origin feature branch'))
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: false,
      ahead: 0,
      behind: 0
    })
  })

  it('keeps a configured upstream whose remote name contains a slash', async () => {
    gitExecFileAsyncMock.mockImplementation((args: string[]) => {
      if (args[0] === 'symbolic-ref') {
        return Promise.resolve({ stdout: 'feature\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('HEAD@{u}')) {
        return Promise.resolve({ stdout: 'origin/team/feature\n' })
      }
      if (args[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\norigin/team\n' })
      }
      if (args[0] === 'rev-parse' && args.includes('refs/remotes/origin/feature')) {
        return Promise.resolve({ stdout: 'origin-feature-oid\n' })
      }
      if (args[0] === 'rev-list' && args.includes('HEAD...origin/team/feature')) {
        return Promise.resolve({ stdout: '2\t0\n' })
      }
      if (args[0] === 'rev-list' && args.includes('HEAD...origin/feature')) {
        return Promise.resolve({ stdout: '9\t9\n' })
      }
      throw new Error(`unexpected git args: ${args.join(' ')}`)
    })

    const result = await getUpstreamStatus('/repo')

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'origin/team/feature',
      ahead: 2,
      behind: 0
    })
  })

  it('uses an explicit publish target instead of the configured upstream', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'abc123\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '1\t2\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: '+ def456 remote work\n', stderr: '' })

    const result = await getUpstreamStatus('/repo', {
      remoteName: 'fork',
      branchName: 'feature/fix'
    })

    expect(result).toEqual({
      hasUpstream: true,
      upstreamName: 'fork/feature/fix',
      ahead: 1,
      behind: 2,
      behindCommitsArePatchEquivalent: false
    })
    expect(gitExecFileAsyncMock.mock.calls).toEqual([
      [['check-ref-format', '--branch', 'feature/fix'], { cwd: '/repo' }],
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

  it('reports no upstream when an explicit publish target has not been fetched yet', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('git exited with 1.'), { stderr: '' }))

    await expect(
      getUpstreamStatus('/repo', {
        remoteName: 'fork',
        branchName: 'feature/fix'
      })
    ).resolves.toEqual({
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
