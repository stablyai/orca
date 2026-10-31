import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'
import { describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  getGitLabProjectRefForRemoteMock,
  getGlabKnownHostsMock,
  gitRunner
} from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, TEST_REPO_PATH, store } from '../orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('refuses SSH GitLab MR bases instead of resolving them on this machine', async () => {
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
    const gitSpy = vi.spyOn(gitRunner, 'gitExecFileAsync')
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(
      runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 77,
        sourceBranch: 'feature',
        targetBranch: 'main',
        isCrossRepository: true
      })
    ).rejects.toThrow(SshHostNotServedError)
    expect(getGlabKnownHostsMock).not.toHaveBeenCalled()
    expect(gitSpy).not.toHaveBeenCalled()
    gitSpy.mockRestore()
  })

  it('keeps the MR source base when the optional compare-base fetch fails', async () => {
    // #6263: deleted merged-MR target refs must not fall back to the default branch.
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
    // Transient fetch failure must retain the compare base already pinned on disk.
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
})
