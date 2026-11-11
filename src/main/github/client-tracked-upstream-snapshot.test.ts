import type * as GitExecFileModule from '../git/command-runner/git-exec-file'
import type * as GhExecFileModule from '../git/command-runner/gh-exec-file'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  gitExecFileAsync: clientMocks.gitExecFileAsyncMock
}))

vi.mock('../git/command-runner/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GhExecFileModule>()),
  ghExecFileAsync: clientMocks.ghExecFileAsyncMock
}))
vi.mock('./local-git-config-signature', () =>
  moduleMocks.localGitConfigSignatureModuleMock(clientMocks)
)
vi.mock('./github-enterprise-repository', async (importOriginal) =>
  moduleMocks.githubEnterpriseRepositoryModuleMock(
    await importOriginal<typeof GitHubEnterpriseRepositoryModule>()
  )
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(clientMocks))
vi.mock('./github-api-repository', async (importOriginal) =>
  moduleMocks.githubApiRepositoryModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryModule>()
  )
)

import { getPRForBranch } from './client/lookup/get-pr-for-branch'
import {
  _getTrackedUpstreamBranchCacheSizesForTests,
  __resetTrackedUpstreamBranchCacheForTests
} from './client/lookup/tracked-upstream-cache'
import { resetPRForBranchMocks } from './client-test-harness'

const {
  ghExecFileAsyncMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock,
  readLocalGitConfigSignatureMock
} = clientMocks

describe('getPRForBranch', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
  })

  it('does not cache positive tracked-upstream entries when config changes during the snapshot', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    readLocalGitConfigSignatureMock
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-a\u0000100')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\0origin/old-upstream\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'feature\0origin/contributor/original\n', stderr: '' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 82,
            title: 'Stable config upstream PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/82',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })

    await getPRForBranch('/repo-root', 'feature')
    const pr = await getPRForBranch('/repo-root', 'feature')

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
    expect(pr).toMatchObject({
      number: 82,
      title: 'Stable config upstream PR'
    })
  })

  it('does not cache synthetic nulls from concurrent tracked-upstream waiters', async () => {
    let resolveSnapshot: (value: { stdout: string; stderr: string }) => void
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    readLocalGitConfigSignatureMock.mockResolvedValue(
      '/repo-root/.git/config\u0000mtime-a\u0000100'
    )
    gitExecFileAsyncMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSnapshot = resolve
          })
      )
      .mockResolvedValueOnce({ stdout: 'new-feature\0origin/contributor/original\n', stderr: '' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 84,
            title: 'Concurrent waiter upstream PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/84',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })

    const existingLookup = getPRForBranch('/repo-root', 'existing')
    const waiterLookup = getPRForBranch('/repo-root', 'new-feature')
    await vi.waitFor(() => expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1))
    resolveSnapshot!({ stdout: 'existing\0\n', stderr: '' })
    const [, waiterPr] = await Promise.all([existingLookup, waiterLookup])

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
    expect(waiterPr).toMatchObject({
      number: 84,
      title: 'Concurrent waiter upstream PR'
    })
  })
})
