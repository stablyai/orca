import { describe, expect, it, vi } from 'vitest'
import {
  ORIGIN_HEAD_COMPONENT,
  ORIGIN_REMOTE_URL,
  OrcaRuntimeService,
  getGitLabProjectRefForRemoteMock,
  getGlabKnownHostsMock,
  gitRunner,
  registerSshGitProvider
} from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, TEST_REPO_PATH, store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('resolves SSH GitLab fork MR bases from the target project MR head ref', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'remote' && args[1] === 'get-url') {
          return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
        }
        if (
          args[0] === 'rev-parse' &&
          args[1] === '--verify' &&
          args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/77^{commit}`
        ) {
          return { stdout: 'remote-fork-mr-sha\n', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      fetchGitLabMergeRequestHead: vi
        .fn()
        .mockResolvedValue(`refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/77`),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', provider as never)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com', 'git.internal'])
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.resolveManagedMrBase({
      repoSelector: 'id:repo-1',
      mrIid: 77,
      sourceBranch: 'contrib/remote-fix',
      targetBranch: 'main',
      isCrossRepository: true
    })

    expect(result).toEqual({
      baseBranch: 'remote-fork-mr-sha',
      compareBaseRef: 'refs/remotes/origin/main'
    })
    expect(provider.fetchGitLabMergeRequestHead).toHaveBeenCalledWith('/remote/repo', 'origin', 77)
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      'main',
      'refs/remotes/origin/main'
    )
    expect(provider.exec).toHaveBeenCalledWith(
      ['rev-parse', '--verify', `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/77^{commit}`],
      '/remote/repo'
    )
    expect(getGitLabProjectRefForRemoteMock).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      ['gitlab.com', 'git.internal'],
      'ssh-1'
    )
  })

  it('resolves SSH GitLab same-repo MR bases through remote-tracking fetches', async () => {
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'origin/feature/fix') {
          return { stdout: 'same-repo-mr-sha\n', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      fetchGitLabMergeRequestHead: vi.fn().mockResolvedValue(undefined),
      fetchRemoteTrackingRef: vi.fn().mockResolvedValue(undefined)
    }
    registerSshGitProvider('ssh-1', provider as never)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com', 'git.internal'])
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    const result = await runtime.resolveManagedMrBase({
      repoSelector: 'id:repo-1',
      mrIid: 78,
      sourceBranch: 'feature/fix',
      targetBranch: 'main'
    })

    expect(result).toEqual({
      baseBranch: 'origin/feature/fix',
      compareBaseRef: 'refs/remotes/origin/main',
      pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
    })
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      'feature/fix',
      'refs/remotes/origin/feature/fix'
    )
    expect(provider.fetchRemoteTrackingRef).toHaveBeenCalledWith(
      '/remote/repo',
      'origin',
      'main',
      'refs/remotes/origin/main'
    )
    expect(provider.fetchGitLabMergeRequestHead).not.toHaveBeenCalled()
    expect(provider.exec).toHaveBeenCalledWith(
      ['rev-parse', '--verify', 'origin/feature/fix'],
      '/remote/repo'
    )
  })

  it('keeps the MR source base when the optional compare-base fetch fails', async () => {
    // Why (#6263): a merged MR's target ref may be deleted; a failed compare-base fetch must not drop the worktree onto the default branch.
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (
        args[0] === 'fetch' &&
        args[2] === '+refs/heads/feature/fix:refs/remotes/origin/feature/fix'
      ) {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'fetch' && args[2] === '+refs/heads/main:refs/remotes/origin/main') {
        // Target branch was deleted on the remote (merged MR).
        throw new Error("couldn't find remote ref refs/heads/main")
      }
      if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'origin/feature/fix') {
        return { stdout: 'same-repo-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 79,
        sourceBranch: 'feature/fix',
        targetBranch: 'main'
      })

      expect(result).toEqual({
        baseBranch: 'origin/feature/fix',
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })
      expect(result).not.toHaveProperty('compareBaseRef')
      expect(result).not.toHaveProperty('error')
    } finally {
      warnSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('keeps the MR compare base when the fetch fails but the local ref resolves', async () => {
    // Why: a transient fetch failure must not drop a compare base we already have on disk.
    const localRepo = {
      id: TEST_REPO_ID,
      path: TEST_REPO_PATH,
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [localRepo],
      getRepo: (id: string) => (id === localRepo.id ? localRepo : undefined)
    }
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const runtime = new OrcaRuntimeService(runtimeStore as never)
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (
        args[0] === 'fetch' &&
        args[2] === '+refs/heads/feature/fix:refs/remotes/origin/feature/fix'
      ) {
        return { stdout: '', stderr: '' }
      }
      if (args[0] === 'fetch' && args[2] === '+refs/heads/main:refs/remotes/origin/main') {
        throw new Error('fatal: unable to access repo: Could not resolve host: gitlab.example')
      }
      if (args[0] === 'rev-parse' && args[2] === 'origin/feature/fix') {
        return { stdout: 'same-repo-mr-sha\n', stderr: '' }
      }
      if (args[0] === 'rev-parse' && args[2] === 'refs/remotes/origin/main^{commit}') {
        return { stdout: 'base-commit-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 80,
        sourceBranch: 'feature/fix',
        targetBranch: 'main'
      })

      expect(result).toEqual({
        baseBranch: 'origin/feature/fix',
        compareBaseRef: 'refs/remotes/origin/main',
        pushTarget: { remoteName: 'origin', branchName: 'feature/fix' }
      })
    } finally {
      warnSpy.mockRestore()
      gitSpy.mockRestore()
    }
  })

  it('keeps a cross-repo fork MR compare base when the fetch fails but the local ref resolves', async () => {
    // Why: mirror the GitHub fork soft-fail-keep — a transient compare-base fetch
    // failure must not drop a base we already have on disk onto the fork MR head SHA.
    const remoteRepo = {
      id: TEST_REPO_ID,
      path: '/remote/repo',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      connectionId: 'ssh-1',
      issueSourcePreference: 'origin' as const
    }
    const runtimeStore = {
      ...store,
      getRepos: () => [remoteRepo],
      getRepo: (id: string) => (id === remoteRepo.id ? remoteRepo : undefined)
    }
    const durableLocalRef = `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/77`
    const provider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[0] === 'rev-parse' && args[2] === `${durableLocalRef}^{commit}`) {
          return { stdout: 'remote-fork-mr-sha\n', stderr: '' }
        }
        if (args[0] === 'rev-parse' && args[2] === 'refs/remotes/origin/main^{commit}') {
          return { stdout: 'base-commit-sha\n', stderr: '' }
        }
        throw new Error(`unexpected git call: ${args.join(' ')}`)
      }),
      fetchGitLabMergeRequestHead: vi.fn().mockResolvedValue(durableLocalRef),
      fetchRemoteTrackingRef: vi.fn(async () => {
        throw new Error('fatal: unable to access repo: Could not resolve host: gitlab.example')
      })
    }
    registerSshGitProvider('ssh-1', provider as never)
    getGlabKnownHostsMock.mockResolvedValue(['gitlab.com', 'git.internal'])
    getGitLabProjectRefForRemoteMock.mockResolvedValue({
      host: 'gitlab.example',
      path: 'group/repo'
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 77,
        sourceBranch: 'contrib/remote-fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        baseBranch: 'remote-fork-mr-sha',
        compareBaseRef: 'refs/remotes/origin/main'
      })
      expect(provider.exec).toHaveBeenCalledWith(
        ['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'],
        '/remote/repo'
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})
