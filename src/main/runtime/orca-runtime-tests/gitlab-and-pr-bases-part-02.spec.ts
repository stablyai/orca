import * as gitExecFile from '../../git/command-runner/git-exec-file'
import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'
import { describe, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import {
  ORIGIN_HEAD_COMPONENT,
  ORIGIN_REMOTE_URL,
  getGitLabProjectRefForRemoteMock,
  getPullRequestPushTargetMock
} from '../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../../../shared/review-head-tracking-ref'
import { TEST_REPO_ID, TEST_REPO_PATH, store } from './orca-runtime-test-fixtures.spec'

describe('OrcaRuntimeService', () => {
  it('refuses SSH GitHub fork PR heads instead of resolving them on this machine', async () => {
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
    const runtime = new OrcaRuntimeService(runtimeStore as never)

    await expect(
      runtime.resolveManagedPrBase({
        repoSelector: 'id:repo-1',
        prNumber: 42,
        headRefName: 'contributor/fix',
        isCrossRepository: true
      })
    ).rejects.toThrow(SshHostNotServedError)
    expect(getPullRequestPushTargetMock).not.toHaveBeenCalled()
  })

  it.each([
    ["fatal: couldn't find remote ref refs/merge-requests/42/head", 'deleted MR / cleaned fork'],
    ['Authentication failed. Check your remote credentials.', 'auth failure'],
    [
      'This SSH host is running an older Orca relay that cannot fetch merge request heads. Reconnect to deploy the latest relay, then try again.',
      'stale relay'
    ]
  ])('fails hard instead of soft-keeping the durable MR head on: %s', async (message) => {
    // Non-transient failures cannot reuse dead/unauthorized tips or hide reconnect prompts.
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
    const gitSpy = vi.spyOn(gitExecFile, 'gitExecFileAsync').mockImplementation(async (args) => {
      if (args[0] === 'remote' && args[1] === 'get-url') {
        return { stdout: `${ORIGIN_REMOTE_URL}\n`, stderr: '' }
      }
      if (args[0] === 'fetch' && args[1] === '--no-tags') {
        throw new Error(message)
      }
      if (args[0] === 'fetch') {
        return { stdout: '', stderr: '' }
      }
      if (
        args[0] === 'rev-parse' &&
        args[2] === `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`
      ) {
        return { stdout: 'pinned-mr-sha\n', stderr: '' }
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    })
    gitSpy.mockClear()
    try {
      const result = await runtime.resolveManagedMrBase({
        repoSelector: 'id:repo-1',
        mrIid: 42,
        sourceBranch: 'contrib/fix',
        targetBranch: 'main',
        isCrossRepository: true
      })

      expect(result).toEqual({
        error: `Failed to fetch refs/merge-requests/42/head: ${message}`,
        errorCode: 'fetchFailed',
        errorParams: { ref: 'refs/merge-requests/42/head' },
        errorDetail: message
      })
      expect(gitSpy).not.toHaveBeenCalledWith(
        ['rev-parse', '--verify', `refs/orca/merge-requests/${ORIGIN_HEAD_COMPONENT}/42^{commit}`],
        expect.anything()
      )
    } finally {
      gitSpy.mockRestore()
    }
  })
})
