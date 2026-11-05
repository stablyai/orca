import * as gitExecFile from '../../git/command-runner/git-exec-file'
import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService, getGlabKnownHostsMock } from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, store } from '../orca-runtime-test-fixtures.spec'

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
    const gitSpy = vi.spyOn(gitExecFile, 'gitExecFileAsync')
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
})
