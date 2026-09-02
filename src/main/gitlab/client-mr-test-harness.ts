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
    if (args[0] === 'symbolic-ref' && args.includes('refs/remotes/origin/HEAD')) {
      return { stdout: `${defaultRef}\n`, stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args.includes(defaultRef)) {
      return { stdout: 'default-oid\n', stderr: '' }
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
