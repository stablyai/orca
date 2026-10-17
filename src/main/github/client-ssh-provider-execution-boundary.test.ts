import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
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
import { getPRForBranchOutcome } from './client/lookup/pr-for-branch-outcome'
import { gitConfigListOutput, resetPRForBranchMocks } from './client-test-harness'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  gitConfigListMock,
  gitExecFileAsyncMock,
  resolvePRRepositoryCandidatesMock
} = clientMocks

const MERGED_BRANCH = 'fix-tab-strip-layout-test'
const MERGED_HEAD_OID = 'current-head-oid'

function mockMergedBranchPRLookup(): void {
  ghExecFileAsyncMock
    .mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 5875,
          title: 'Merged current branch PR',
          state: 'closed',
          merged_at: '2026-06-20T04:53:05Z',
          html_url: 'https://github.com/acme/widgets/pull/5875',
          updated_at: '2026-06-20T04:53:05Z',
          draft: false,
          mergeable_state: 'clean',
          head: { ref: MERGED_BRANCH, sha: MERGED_HEAD_OID },
          base: { ref: 'main', sha: 'base-oid' }
        }
      ])
    })
    .mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 5875,
        title: 'Merged current branch PR',
        state: 'MERGED',
        url: 'https://github.com/acme/widgets/pull/5875',
        statusCheckRollup: [],
        updatedAt: '2026-06-20T04:53:05Z',
        isDraft: false,
        mergeable: 'MERGEABLE',
        baseRefName: 'main',
        headRefName: MERGED_BRANCH,
        baseRefOid: 'base-oid',
        headRefOid: MERGED_HEAD_OID
      })
    })
}

// The strict execution boundary: for an SSH-hosted repoPath, an unregistered
// provider means "we could not ask" — it must never degrade into a client-side
// git run, which on a same-named local path answers for the wrong repository.
describe('getPRForBranch SSH execution boundary', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
  })

  it('does not rev-parse HEAD locally when the SSH provider is unregistered', async () => {
    mockMergedBranchPRLookup()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: `${MERGED_HEAD_OID}\n`, stderr: '' })

    const outcome = await getPRForBranchOutcome('/remote/repo', MERGED_BRANCH, null, 'ssh-1')

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'upstream-error', errorType: 'unknown' })
  })

  it('reports an upstream error when SSH candidate discovery is unverifiable', async () => {
    resolvePRRepositoryCandidatesMock.mockRejectedValue(
      new Error('Remote repository identity is unverifiable.')
    )

    const outcome = await getPRForBranchOutcome('/remote/repo', MERGED_BRANCH, null, 'ssh-1')

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'upstream-error', errorType: 'unknown' })
  })

  it('keeps a verified empty SSH candidate set as no PR', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({ candidates: [], headRepo: null })

    const outcome = await getPRForBranchOutcome('/remote/repo', MERGED_BRANCH, null, 'ssh-1')

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'no-pr' })
  })

  it('rev-parses HEAD through the local runtime for a WSL repository', async () => {
    mockMergedBranchPRLookup()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: `${MERGED_HEAD_OID}\n`, stderr: '' })

    const pr = await getPRForBranch('/repo-root', MERGED_BRANCH, null, null, null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['rev-parse', 'HEAD'], {
      cwd: '/repo-root',
      wslDistro: 'Ubuntu'
    })
    expect(pr).toMatchObject({ number: 5875, state: 'merged', headSha: MERGED_HEAD_OID })
  })

  it('does not read git config locally when the SSH provider is unregistered', async () => {
    const outcome = await getPRForBranchOutcome('/remote/repo', MERGED_BRANCH, null, 'ssh-1')

    expect(gitConfigListMock).not.toHaveBeenCalled()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'upstream-error', errorType: 'unknown' })
  })

  it('reports an upstream error when the SSH HEAD probe loses its provider mid-flight', async () => {
    mockMergedBranchPRLookup()

    const outcome = await getPRForBranchOutcome('/remote/repo', MERGED_BRANCH, null, 'ssh-1')

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ kind: 'upstream-error', errorType: 'unknown' })
  })

  it('reads the review head from git config through the local runtime for a WSL repository', async () => {
    gitConfigListMock.mockResolvedValue(
      gitConfigListOutput([
        [`branch.${MERGED_BRANCH}.remote`, 'fork'],
        [`branch.${MERGED_BRANCH}.merge`, `refs/heads/${MERGED_BRANCH}`]
      ])
    )
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remote: string) =>
      remote === 'fork' ? { owner: 'contributor', repo: 'widgets' } : null
    )
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    await getPRForBranch('/repo-root', MERGED_BRANCH, null, null, null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })

    expect(gitConfigListMock).toHaveBeenCalledWith(['config', '--list', '-z'], {
      cwd: '/repo-root',
      wslDistro: 'Ubuntu'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', `repos/acme/widgets/pulls?head=contributor%3A${MERGED_BRANCH}&state=all&per_page=10`],
      expect.anything()
    )
  })
})
