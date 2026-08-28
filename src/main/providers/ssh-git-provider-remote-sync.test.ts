import { describe, expect, it, beforeEach } from 'vitest'
import { SshGitProvider } from './ssh-git-provider'
import { createMockMux, type MockMultiplexer } from './ssh-git-provider-test-harness'
import { REBASE_FROM_BASE_RPC_TIMEOUT_MS } from '../../shared/git-rebase-source'

describe('SshGitProvider', () => {
  let mux: MockMultiplexer
  let provider: SshGitProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshGitProvider('conn-1', mux as never)
  })

  it('getUpstreamStatus sends git.upstreamStatus request', async () => {
    const upstreamResult = { hasUpstream: true, upstreamName: 'origin/main', ahead: 1, behind: 0 }
    mux.request.mockResolvedValue(upstreamResult)

    const result = await provider.getUpstreamStatus('/home/user/repo')
    expect(mux.request).toHaveBeenCalledWith('git.upstreamStatus', {
      worktreePath: '/home/user/repo'
    })
    expect(result).toEqual(upstreamResult)
  })

  it('getUpstreamStatus forwards an explicit push target', async () => {
    const upstreamResult = { hasUpstream: true, upstreamName: 'fork/feature', ahead: 0, behind: 1 }
    mux.request.mockResolvedValue(upstreamResult)

    const pushTarget = { remoteName: 'fork', branchName: 'feature' }
    const result = await provider.getUpstreamStatus('/home/user/repo', pushTarget)

    expect(mux.request).toHaveBeenCalledWith('git.upstreamStatus', {
      worktreePath: '/home/user/repo',
      pushTarget
    })
    expect(result).toEqual(upstreamResult)
  })

  it('pushBranch sends git.push request and forwards publish mode and target', async () => {
    await provider.pushBranch('/home/user/repo', true, {
      remoteName: 'pr-fork-orca',
      branchName: 'contributor/fix'
    })
    expect(mux.request).toHaveBeenCalledWith('git.push', {
      worktreePath: '/home/user/repo',
      publish: true,
      pushTarget: {
        remoteName: 'pr-fork-orca',
        branchName: 'contributor/fix'
      }
    })
  })

  it('pushBranch forwards force-with-lease mode', async () => {
    await provider.pushBranch('/home/user/repo', false, undefined, { forceWithLease: true })

    expect(mux.request).toHaveBeenCalledWith('git.push', {
      worktreePath: '/home/user/repo',
      publish: false,
      pushTarget: undefined,
      forceWithLease: true
    })
  })

  it('pullBranch sends git.pull request', async () => {
    await provider.pullBranch('/home/user/repo')
    expect(mux.request).toHaveBeenCalledWith('git.pull', {
      worktreePath: '/home/user/repo'
    })
  })

  it('pullBranch forwards an explicit push target', async () => {
    const pushTarget = { remoteName: 'fork', branchName: 'feature' }

    await provider.pullBranch('/home/user/repo', pushTarget)

    expect(mux.request).toHaveBeenCalledWith('git.pull', {
      worktreePath: '/home/user/repo',
      pushTarget
    })
  })

  it('fastForwardBranch sends git.fastForward request', async () => {
    await provider.fastForwardBranch('/home/user/repo')
    expect(mux.request).toHaveBeenCalledWith('git.fastForward', {
      worktreePath: '/home/user/repo'
    })
  })

  it('fastForwardBranch forwards an explicit push target', async () => {
    const pushTarget = { remoteName: 'fork', branchName: 'feature' }

    await provider.fastForwardBranch('/home/user/repo', pushTarget)

    expect(mux.request).toHaveBeenCalledWith('git.fastForward', {
      worktreePath: '/home/user/repo',
      pushTarget
    })
  })

  it('rebaseFromBase sends git.rebaseFromBase request', async () => {
    await provider.rebaseFromBase('/home/user/repo', 'upstream/main')

    expect(mux.request).toHaveBeenCalledWith(
      'git.rebaseFromBase',
      {
        worktreePath: '/home/user/repo',
        baseRef: 'upstream/main'
      },
      { timeoutMs: REBASE_FROM_BASE_RPC_TIMEOUT_MS }
    )
  })

  it('fetchRemote sends git.fetch request', async () => {
    await provider.fetchRemote('/home/user/repo')
    expect(mux.request).toHaveBeenCalledWith('git.fetch', {
      worktreePath: '/home/user/repo'
    })
  })

  it('fetchRemote forwards an explicit push target', async () => {
    const pushTarget = { remoteName: 'fork', branchName: 'feature' }

    await provider.fetchRemote('/home/user/repo', pushTarget)

    expect(mux.request).toHaveBeenCalledWith('git.fetch', {
      worktreePath: '/home/user/repo',
      pushTarget
    })
  })

  it('syncForkDefaultBranch sends git.forkSync request', async () => {
    const syncResult = {
      status: 'synced',
      originRemote: 'origin',
      upstreamRemote: 'upstream',
      branchName: 'main',
      ahead: 0,
      behind: 2
    }
    mux.request.mockResolvedValue(syncResult)

    const expectedUpstream = { owner: 'stablyai', repo: 'orca' }
    const result = await provider.syncForkDefaultBranch('/home/user/repo', expectedUpstream)

    expect(mux.request).toHaveBeenCalledWith('git.forkSync', {
      worktreePath: '/home/user/repo',
      expectedUpstream
    })
    expect(result).toEqual(syncResult)
  })

  it('fetchRemoteTrackingRef sends git.fetchRemoteTrackingRef request', async () => {
    await provider.fetchRemoteTrackingRef(
      '/home/user/repo',
      'origin',
      'main',
      'refs/remotes/origin/main',
      { skipAutoMaintenance: true }
    )

    expect(mux.request).toHaveBeenCalledWith('git.fetchRemoteTrackingRef', {
      worktreePath: '/home/user/repo',
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      skipAutoMaintenance: true
    })
  })

  it('fetchGitLabMergeRequestHead sends the durable-ref git.fetchGitLabMergeRequestHeadRef request', async () => {
    mux.request.mockResolvedValueOnce({
      localRef: 'refs/orca/merge-requests/origin-abc/42'
    })

    const localRef = await provider.fetchGitLabMergeRequestHead('/home/user/repo', 'origin', 42)

    expect(mux.request).toHaveBeenCalledWith('git.fetchGitLabMergeRequestHeadRef', {
      worktreePath: '/home/user/repo',
      remote: 'origin',
      mrIid: 42
    })
    expect(localRef).toBe('refs/orca/merge-requests/origin-abc/42')
  })

  it('fetchGitLabMergeRequestHead maps old relays to the reconnect message', async () => {
    const methodNotFound = Object.assign(
      new Error('Method not found: git.fetchGitLabMergeRequestHeadRef'),
      { code: -32601 }
    )
    mux.request.mockRejectedValueOnce(methodNotFound)

    await expect(
      provider.fetchGitLabMergeRequestHead('/home/user/repo', 'origin', 42)
    ).rejects.toThrow(
      'This SSH host is running an older Orca relay that cannot fetch merge request heads. Reconnect to deploy the latest relay, then try again.'
    )
  })

  it('fetchGitLabMergeRequestHead rethrows non-method-not-found errors', async () => {
    const error = new Error('fatal: could not read from remote repository')
    mux.request.mockRejectedValueOnce(error)

    await expect(
      provider.fetchGitLabMergeRequestHead('/home/user/repo', 'origin', 42)
    ).rejects.toBe(error)
  })

  it('fetchGitHubPullRequestHead sends git.fetchGitHubPullRequestHead request', async () => {
    mux.request.mockResolvedValueOnce({ localRef: 'refs/orca/pull/origin-abc/42' })

    const localRef = await provider.fetchGitHubPullRequestHead('/home/user/repo', 'origin', 42)

    expect(mux.request).toHaveBeenCalledWith('git.fetchGitHubPullRequestHead', {
      worktreePath: '/home/user/repo',
      remote: 'origin',
      prNumber: 42
    })
    expect(localRef).toBe('refs/orca/pull/origin-abc/42')
  })

  it('fetchGitHubPullRequestHead rejects relays that omit the durable localRef', async () => {
    mux.request.mockResolvedValueOnce({})

    await expect(
      provider.fetchGitHubPullRequestHead('/home/user/repo', 'origin', 42)
    ).rejects.toThrow('did not return the durable pull request head ref')
  })

  it('fetchGitHubPullRequestHead maps old relays to the reconnect message', async () => {
    const methodNotFound = Object.assign(
      new Error('Method not found: git.fetchGitHubPullRequestHead'),
      { code: -32601 }
    )
    mux.request.mockRejectedValueOnce(methodNotFound)

    await expect(
      provider.fetchGitHubPullRequestHead('/home/user/repo', 'origin', 42)
    ).rejects.toThrow(
      'This SSH host is running an older Orca relay that cannot fetch pull request heads. Reconnect to deploy the latest relay, then try again.'
    )
  })

  it('fetchGitHubPullRequestHead rethrows non-method-not-found errors', async () => {
    const error = new Error('fatal: could not read from remote repository')
    mux.request.mockRejectedValueOnce(error)

    await expect(provider.fetchGitHubPullRequestHead('/home/user/repo', 'origin', 42)).rejects.toBe(
      error
    )
  })
})
