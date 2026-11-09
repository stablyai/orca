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

import { isGitHubHostAuthenticated } from './github-enterprise-repository'
import { getPRForBranch } from './client/lookup/get-pr-for-branch'
import { getPRForBranchOutcome } from './client/lookup/pr-for-branch-outcome'
import { resetPRForBranchMocks } from './client-test-harness'
import { hostedReviewOptionArgs } from './pr-refresh-candidate-policy'
import { completePRCheckGraphQLResponse } from '../../shared/github/complete-pr-check-test-fixture'

const {
  ghExecFileAsyncMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock
} = clientMocks

describe('getPRForBranch', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
  })

  it('keeps failed fork-parent discovery retryable instead of reporting no PR', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'fork-owner', repo: 'orca' }],
      headRepo: { owner: 'fork-owner', repo: 'orca' }
    })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValue({ stdout: '[]' })

    const outcome = await getPRForBranchOutcome('/repo-root', 'work', null, null, null, {
      headRepository: { owner: 'fork-owner', repo: 'orca' }
    })

    expect(outcome).toMatchObject({ kind: 'upstream-error' })
  })

  it('never reads a linked PR on an unconfigured, unauthenticated host', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: { owner: 'stablyai', repo: 'orca' }
    })
    vi.mocked(isGitHubHostAuthenticated).mockResolvedValueOnce(false)

    const outcome = await getPRForBranchOutcome('/repo-root', 'work', 42, null, null, {
      exactRepository: { owner: 'stablyai', repo: 'orca', host: 'ghe.attacker.example' }
    })

    expect(outcome).toMatchObject({ kind: 'upstream-error', errorType: 'auth' })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('never asks an unauthenticated push host for its fork parent', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: { owner: 'stablyai', repo: 'orca' }
    })
    vi.mocked(isGitHubHostAuthenticated).mockResolvedValueOnce(false)
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '[]' })

    await getPRForBranchOutcome('/repo-root', 'work', null, null, null, {
      headRepository: { owner: 'fork-owner', repo: 'orca', host: 'git.attacker.example' }
    })

    expect(ghExecFileAsyncMock.mock.calls.map(([args]) => args)).not.toContainEqual(
      expect.arrayContaining(['repo', 'view'])
    )
  })

  it('finds a PR in the known fork without requiring access to its parent', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'fork-owner', repo: 'orca' }],
      headRepo: { owner: 'fork-owner', repo: 'orca' }
    })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 72,
            title: 'Fork PR',
            state: 'open',
            html_url: 'https://github.com/fork-owner/orca/pull/72',
            head: { ref: 'work', sha: 'fork-head' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 72,
          title: 'Fork PR',
          state: 'OPEN',
          url: 'https://github.com/fork-owner/orca/pull/72',
          mergeable: 'MERGEABLE',
          headRefName: 'work',
          headRefOid: 'fork-head',
          statusCheckRollup: []
        })
      })
      .mockRejectedValue(new Error('parent inaccessible'))

    const pr = await getPRForBranch('/repo-root', 'work', null, null, null, {
      headRepository: { owner: 'fork-owner', repo: 'orca' }
    })

    expect(pr).toMatchObject({ number: 72, prRepo: { owner: 'fork-owner', repo: 'orca' } })
  })

  it.each([
    { originOwner: 'stablyai', staleMerged: false },
    { originOwner: 'fork-owner', staleMerged: false },
    { originOwner: 'fork-owner', staleMerged: true },
    { originOwner: 'other-fork', staleMerged: false }
  ])(
    'discovers a parent PR with origin $originOwner and stale merged fork PR $staleMerged',
    async ({ originOwner, staleMerged }) => {
      resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
        candidates: [{ owner: originOwner, repo: 'orca' }],
        headRepo: { owner: originOwner, repo: 'orca' }
      })
      if (originOwner !== 'stablyai') {
        if (originOwner === 'other-fork') {
          ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })
        }
        if (staleMerged) {
          ghExecFileAsyncMock
            .mockResolvedValueOnce({
              stdout: JSON.stringify([
                {
                  number: 11,
                  title: 'Old fork work',
                  state: 'closed',
                  merged_at: '2026-01-01T00:00:00Z',
                  html_url: 'https://github.com/fork-owner/orca/pull/11',
                  head: { ref: 'work', sha: 'old-head' }
                }
              ])
            })
            .mockResolvedValueOnce({
              stdout: JSON.stringify({
                number: 11,
                title: 'Old fork work',
                state: 'MERGED',
                url: 'https://github.com/fork-owner/orca/pull/11',
                mergeable: 'MERGEABLE',
                headRefName: 'work',
                headRefOid: 'old-head',
                statusCheckRollup: []
              })
            })
            .mockResolvedValueOnce(completePRCheckGraphQLResponse(11, 'old-head'))
        } else {
          ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })
        }
        ghExecFileAsyncMock.mockResolvedValueOnce({
          stdout: JSON.stringify({
            isFork: true,
            parent: { name: 'orca', owner: { login: 'stablyai' } }
          })
        })
      }
      ghExecFileAsyncMock
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            {
              number: 91,
              title: 'Published fork work',
              state: 'open',
              html_url: 'https://github.com/stablyai/orca/pull/91',
              head: {
                ref: 'work',
                sha: 'published-head',
                repo: { name: 'orca', owner: { login: 'fork-owner' } }
              }
            }
          ])
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            number: 91,
            title: 'Published fork work',
            state: 'OPEN',
            url: 'https://github.com/stablyai/orca/pull/91',
            statusCheckRollup: [],
            mergeable: 'MERGEABLE',
            headRefName: 'work',
            headRefOid: 'published-head',
            headRepositoryOwner: { login: 'fork-owner' },
            headRepository: { name: 'orca' }
          })
        })
      const options = hostedReviewOptionArgs(
        { headRepository: { owner: 'fork-owner', repo: 'orca' }, currentHeadOid: 'published-head' },
        'post-push'
      )[0]

      const pr = await getPRForBranch('/repo-root', 'work', null, null, null, options)

      expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
        [
          'api',
          'repos/stablyai/orca/pulls?head=fork-owner%3Awork&state=all&per_page=10',
          '--include'
        ],
        { cwd: '/repo-root' }
      )
      expect(pr).toMatchObject({
        number: 91,
        prRepo: { owner: 'stablyai', repo: 'orca' },
        headRepo: { owner: 'fork-owner', repo: 'orca' }
      })
    }
  )

  it('uses the tracked upstream remote owner for fork branch lookup', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'origin-owner', repo: 'orca' }
      ],
      headRepo: { owner: 'origin-owner', repo: 'orca' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'fork-owner', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 78,
            title: 'Fork upstream branch PR',
            state: 'open',
            html_url: 'https://github.com/stablyai/orca/pull/78',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 78,
          title: 'Hydrated fork upstream branch PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/78',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'upstream-head-oid'
        })
      })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'local-created-from-pr\0fork/contributor/original\n',
      stderr: ''
    })

    const pr = await getPRForBranch('/repo-root', 'local-created-from-pr')

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/repo-root', 'fork', undefined)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      [
        'api',
        'repos/stablyai/orca/pulls?head=fork-owner%3Acontributor%2Foriginal&state=all&per_page=10',
        '--include'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 78,
      title: 'Hydrated fork upstream branch PR',
      prRepo: { owner: 'stablyai', repo: 'orca' },
      headRepo: { owner: 'fork-owner', repo: 'orca' }
    })
  })

  it('uses the tracked upstream remote owner when the fork branch name matches locally', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'origin-owner', repo: 'orca' }
      ],
      headRepo: { owner: 'origin-owner', repo: 'orca' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'brennanb2025', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 6433,
            title: 'Recover Windows worktree deletes from long paths',
            state: 'open',
            html_url: 'https://github.com/stablyai/orca/pull/6433',
            updated_at: '2026-06-26T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: {
              ref: 'brennanb2025/worktree-remove-fix',
              sha: 'same-name-fork-head-oid'
            }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 6433,
          title: 'Recover Windows worktree deletes from long paths',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/6433',
          statusCheckRollup: [],
          updatedAt: '2026-06-26T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'brennanb2025/worktree-remove-fix',
          baseRefOid: 'base-oid',
          headRefOid: 'same-name-fork-head-oid'
        })
      })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'brennanb2025/worktree-remove-fix\0brennan/brennanb2025/worktree-remove-fix\n',
      stderr: ''
    })

    const pr = await getPRForBranch('/repo-root', 'brennanb2025/worktree-remove-fix')

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/repo-root', 'brennan', undefined)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      [
        'api',
        'repos/stablyai/orca/pulls?head=brennanb2025%3Abrennanb2025%2Fworktree-remove-fix&state=all&per_page=10',
        '--include'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 6433,
      prRepo: { owner: 'stablyai', repo: 'orca' },
      headRepo: { owner: 'brennanb2025', repo: 'orca' }
    })
  })
})
