import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, getSshGitProviderMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  getSshGitProviderMock: vi.fn()
}))

vi.mock('../git/runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('../providers/ssh-git-dispatch', () => ({ getSshGitProvider: getSshGitProviderMock }))

import {
  _resetBranchHeadRemoteCache,
  resolveBranchHeadRemoteName
} from './github-branch-head-remote'

const REPO = '/repo/app'
const BRANCH = 'dcieslak19973/bitbucket-datacenter-support'

/** Routes each git invocation to a canned stdout by its leading subcommand + key. */
function stubGit(responses: { refs?: string; config?: Record<string, string> }): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'for-each-ref') {
      if (responses.refs === undefined) {
        throw new Error('git for-each-ref failed')
      }
      return { stdout: responses.refs, stderr: '' }
    }
    if (args[0] === 'config') {
      const value = responses.config?.[args[2] ?? '']
      if (value === undefined) {
        // git exits non-zero for a missing key.
        throw new Error('exit 1')
      }
      return { stdout: `${value}\n`, stderr: '' }
    }
    throw new Error(`unexpected git ${args.join(' ')}`)
  })
}

beforeEach(() => {
  _resetBranchHeadRemoteCache()
  gitExecFileAsyncMock.mockReset()
  getSshGitProviderMock.mockReset()
  getSshGitProviderMock.mockReturnValue(null)
})

describe('resolveBranchHeadRemoteName', () => {
  // The #12956 case: `git push fork <branch>` sets no upstream, and the fork is
  // not `origin`. The tracking ref is the only local evidence.
  it('resolves the non-origin remote holding the branch', async () => {
    stubGit({ refs: `refs/remotes/fork/${BRANCH}\n` })

    await expect(resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })).resolves.toBe(
      'fork'
    )
    // One local git call on the common path.
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('resolves origin for the standard fork layout', async () => {
    stubGit({ refs: `refs/remotes/origin/${BRANCH}\n` })

    await expect(resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })).resolves.toBe(
      'origin'
    )
  })

  // Why: a branch name with slashes must not have its leading segment mistaken
  // for the remote — the remainder after the remote is matched as an exact suffix.
  it('does not mis-split a slashed branch name', async () => {
    stubGit({ refs: 'refs/remotes/fork/user/feature/deep\n' })

    await expect(
      resolveBranchHeadRemoteName({ repoPath: REPO, branchName: 'user/feature/deep' })
    ).resolves.toBe('fork')
  })

  it('returns null when several remotes carry the branch and nothing names one', async () => {
    stubGit({ refs: `refs/remotes/fork/${BRANCH}\nrefs/remotes/innocarpe/${BRANCH}\n` })

    // Null routes the caller to the head-owner-agnostic list query rather than
    // guessing a fork and filtering on the wrong owner.
    await expect(
      resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })
    ).resolves.toBeNull()
  })

  it('disambiguates several remotes with a configured push target', async () => {
    stubGit({
      refs: `refs/remotes/fork/${BRANCH}\nrefs/remotes/innocarpe/${BRANCH}\n`,
      config: { [`branch.${BRANCH}.pushRemote`]: 'innocarpe' }
    })

    await expect(resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })).resolves.toBe(
      'innocarpe'
    )
  })

  it('ignores a configured remote that contradicts the tracking refs', async () => {
    stubGit({
      refs: `refs/remotes/fork/${BRANCH}\nrefs/remotes/innocarpe/${BRANCH}\n`,
      config: { 'remote.pushDefault': 'somewhere-else' }
    })

    await expect(
      resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })
    ).resolves.toBeNull()
  })

  it('falls back to upstream configuration when no tracking ref exists yet', async () => {
    stubGit({ refs: '', config: { [`branch.${BRANCH}.remote`]: 'fork' } })

    await expect(resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })).resolves.toBe(
      'fork'
    )
  })

  it('returns null for an unpushed branch with no configuration', async () => {
    stubGit({ refs: '', config: {} })

    await expect(
      resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })
    ).resolves.toBeNull()
  })

  it('degrades to null when git cannot be run', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('spawn ENOENT'))

    await expect(
      resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })
    ).resolves.toBeNull()
  })

  it('never spawns git for a detached head', async () => {
    await expect(
      resolveBranchHeadRemoteName({ repoPath: REPO, branchName: 'HEAD' })
    ).resolves.toBeNull()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('routes through the SSH provider for connection-backed repos', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: `refs/remotes/fork/${BRANCH}\n`, stderr: '' })
    getSshGitProviderMock.mockReturnValue({ exec })

    await expect(
      resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH, connectionId: 'ssh-1' })
    ).resolves.toBe('fork')
    expect(exec).toHaveBeenCalledWith(
      ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${BRANCH}`],
      REPO
    )
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
  // Why: repoPath names the remote host's filesystem. Running local git there
  // could read an unrelated repo that happens to sit at the same path.
  it('never falls back to local git when the SSH provider is unavailable', async () => {
    stubGit({ refs: `refs/remotes/fork/${BRANCH}\n` })
    getSshGitProviderMock.mockReturnValue(null)

    await expect(
      resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH, connectionId: 'ssh-1' })
    ).resolves.toBeNull()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})

describe('branch head remote cache', () => {
  it('serves a repeat resolution without spawning git again', async () => {
    stubGit({ refs: `refs/remotes/fork/${BRANCH}\n` })

    await resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })
    await resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('caches a null answer so an unpushed branch is not re-probed', async () => {
    stubGit({ refs: '', config: {} })

    await expect(
      resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })
    ).resolves.toBeNull()
    const callsAfterFirst = gitExecFileAsyncMock.mock.calls.length
    await expect(
      resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })
    ).resolves.toBeNull()

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(callsAfterFirst)
  })

  it('re-probes once the entry expires', async () => {
    vi.useFakeTimers()
    try {
      stubGit({ refs: `refs/remotes/fork/${BRANCH}\n` })
      await resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })

      // Past the 30s window: a branch pushed to a new remote must be picked up.
      vi.advanceTimersByTime(31_000)
      await resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })

      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keys separately per branch, per repo, and per connection', async () => {
    stubGit({ refs: `refs/remotes/fork/${BRANCH}\n` })
    const exec = vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    getSshGitProviderMock.mockReturnValue({ exec })

    await resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })
    await resolveBranchHeadRemoteName({ repoPath: REPO, branchName: 'other/branch' })
    await resolveBranchHeadRemoteName({ repoPath: '/repo/other', branchName: BRANCH })
    await resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH, connectionId: 'ssh-1' })

    // Three distinct local keys, and the SSH runtime is a fourth.
    expect(
      gitExecFileAsyncMock.mock.calls.filter(([args]) => args[0] === 'for-each-ref')
    ).toHaveLength(3)
    // The SSH runtime is a fourth key, so it probes on its own transport
    // (its empty result then falls through to config, which is expected).
    expect(exec.mock.calls.filter(([args]) => args[0] === 'for-each-ref')).toHaveLength(1)
  })

  it('coalesces concurrent misses into one probe', async () => {
    stubGit({ refs: `refs/remotes/fork/${BRANCH}\n` })

    const [a, b, c] = await Promise.all([
      resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH }),
      resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH }),
      resolveBranchHeadRemoteName({ repoPath: REPO, branchName: BRANCH })
    ])

    expect([a, b, c]).toEqual(['fork', 'fork', 'fork'])
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })
})
