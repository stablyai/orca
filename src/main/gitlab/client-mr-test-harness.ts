import type { Mock } from 'vitest'
import { _resetGitLabRateLimitCache } from './client'
import { __resetRepoDefaultBranchCacheForTests } from '../source-control/repo-default-branch'
import { _resetKnownHostsCache } from './gitlab-known-host-probe'

/** The hoisted gl-utils / git-runner mocks every GitLab MR test file installs. */
export type GitLabMrMocks = {
  glabExecFileAsyncMock: Mock
  glabApiWithHeadersMock: Mock
  getGlabKnownHostsMock: Mock
  getProjectRefMock: Mock
  resolveIssueSourceMock: Mock
  acquireMock: Mock
  releaseMock: Mock
  gitExecFileAsyncMock: Mock
}

/** Answer the real default-branch resolver probes (#9171 guard). */
export function primeGitDefaultBranch(
  gitExecFileAsyncMock: Mock,
  defaultRef = 'refs/remotes/origin/main'
): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'for-each-ref' && args.includes('--format=%(refname)%00%(symref)')) {
      return { stdout: `refs/remotes/origin/HEAD\0${defaultRef}\n`, stderr: '' }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
}

/** Shared per-test reset: mocks, module caches, and the default host/source stubs. */
export function resetGitLabMrMocks(mocks: GitLabMrMocks): void {
  mocks.glabExecFileAsyncMock.mockReset()
  mocks.glabApiWithHeadersMock.mockReset()
  mocks.getGlabKnownHostsMock.mockReset()
  mocks.getProjectRefMock.mockReset()
  mocks.resolveIssueSourceMock.mockReset()
  mocks.acquireMock.mockReset()
  mocks.releaseMock.mockReset()
  mocks.acquireMock.mockResolvedValue(undefined)
  mocks.gitExecFileAsyncMock.mockReset()
  primeGitDefaultBranch(mocks.gitExecFileAsyncMock)
  __resetRepoDefaultBranchCacheForTests()
  _resetKnownHostsCache()
  _resetGitLabRateLimitCache()
  mocks.getGlabKnownHostsMock.mockResolvedValue(['gitlab.com'])
  mocks.resolveIssueSourceMock.mockResolvedValue({
    source: { host: 'gitlab.com', path: 'g/p' },
    fellBack: false
  })
}
