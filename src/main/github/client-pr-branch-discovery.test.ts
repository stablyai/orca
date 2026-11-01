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
import { lookupPRByBranchName } from './client/lookup/pr-branch-lookup'
import { resetPRForBranchMocks } from './client-test-harness'
import { canShowGitHubPRAutoMergeControl } from '../../shared/github/pull-request-auto-merge-availability'

const {
  execFileAsyncMock,
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  resolvePRRepositoryCandidatesMock
} = clientMocks

describe('getPRForBranch', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
  })

  it.each([
    { restEnabled: false, graphqlEnabled: true },
    { restEnabled: true, graphqlEnabled: false }
  ])(
    'uses exact GraphQL auto-merge state ($graphqlEnabled) over REST discovery ($restEnabled)',
    async ({ restEnabled, graphqlEnabled }) => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      ghExecFileAsyncMock
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            {
              number: 42,
              title: 'Fix PR discovery',
              state: 'open',
              html_url: 'https://github.com/acme/widgets/pull/42',
              updated_at: '2026-10-21T16:31:00Z',
              draft: false,
              mergeable: true,
              mergeable_state: 'blocked',
              auto_merge: restEnabled ? { merge_method: 'squash' } : null,
              base: { ref: 'main', sha: 'base-oid' },
              head: { ref: 'feature/test', sha: 'head-oid' }
            }
          ])
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            number: 42,
            title: 'Fix PR discovery',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            updatedAt: '2026-10-21T16:32:00Z',
            statusCheckRollup: [],
            isDraft: false,
            mergeable: 'MERGEABLE',
            mergeStateStatus: 'BLOCKED',
            autoMergeRequest: graphqlEnabled ? { enabledAt: '2026-10-21T16:32:00Z' } : null,
            baseRefName: 'main',
            baseRefOid: 'base-oid',
            headRefName: 'feature/test',
            headRefOid: 'head-oid'
          })
        })
        .mockResolvedValue({
          stdout: JSON.stringify({
            data: {
              repository: {
                autoMergeAllowed: true,
                mergeQueue: null,
                ref: { rules: { nodes: [{ type: 'PULL_REQUEST' }] } }
              }
            }
          })
        })

      const pr = await getPRForBranch('/repo-root', 'feature/test')

      expect(pr).toMatchObject({ number: 42, autoMergeEnabled: graphqlEnabled })
    }
  )

  it.each([
    ['unstable', true, false],
    ['unstable', null, false],
    ['blocked', true, true],
    ['behind', true, true],
    ['dirty', false, false],
    ['unknown', null, false]
  ] as const)(
    'preserves REST %s eligibility when exact GraphQL lookup fails (mergeable=%s)',
    async (mergeable_state, mergeable, autoMergeAvailable) => {
      getOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
      ghExecFileAsyncMock
        .mockRejectedValueOnce(new Error('network unavailable'))
        .mockResolvedValueOnce({
          stdout: JSON.stringify({
            number: 31259,
            title: 'fix(i18n): restore localized editor safety copy',
            state: 'open',
            html_url: 'https://github.com/stablyai/orca/pull/31259',
            updated_at: '2026-10-21T16:31:00Z',
            draft: false,
            mergeable,
            mergeable_state,
            auto_merge: null,
            base: { ref: 'main', sha: 'base-oid' },
            head: {
              ref: 'fix/editor-safety-copy',
              sha: 'e4353ead012043474fc723e50aea198a76d32979'
            }
          })
        })
        .mockResolvedValue({
          stdout: JSON.stringify({
            data: {
              repository: {
                autoMergeAllowed: true,
                mergeQueue: null,
                ref: { rules: { nodes: [{ type: 'PULL_REQUEST' }] } }
              }
            }
          })
        })

      const pr = await getPRForBranch('/repo-root', 'fix/editor-safety-copy', 31259)
      expect(pr).toMatchObject({
        mergeStateStatus: mergeable_state.toUpperCase(),
        autoMergeEnabled: false
      })
      if (!pr) {
        throw new Error('Expected a discovered PR')
      }
      expect(canShowGitHubPRAutoMergeControl(pr)).toBe(autoMergeAvailable)
    }
  )

  it('does not infer auto-merge eligibility from a branch list result when exact lookup fails', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 31259,
            title: 'fix(i18n): restore localized editor safety copy',
            state: 'open',
            html_url: 'https://github.com/stablyai/orca/pull/31259',
            updated_at: '2026-10-21T16:31:00Z',
            draft: false,
            auto_merge: null,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'fix/editor-safety-copy', sha: 'e4353ead012043474fc723e50aea198a76d32979' }
          }
        ])
      })
      .mockRejectedValueOnce(new Error('network unavailable'))

    const pr = await getPRForBranch('/repo-root', 'fix/editor-safety-copy')
    expect(pr).toMatchObject({ number: 31259, mergeable: 'UNKNOWN', autoMergeEnabled: false })
    expect(pr?.mergeStateStatus).toBeUndefined()
    if (!pr) {
      throw new Error('Expected a discovered PR')
    }
    expect(canShowGitHubPRAutoMergeControl(pr)).toBe(false)
  })

  it('queries GitHub by head branch when the remote is on github.com', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable: true,
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })

    const pr = await getPRForBranch('/repo-root', 'refs/heads/feature/test')

    expect(getOwnerRepoMock).toHaveBeenCalledWith('/repo-root', undefined)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        'repos/acme/widgets/pulls?head=acme%3Afeature%2Ftest&state=all&per_page=1',
        '--include'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr?.number).toBe(42)
    expect(pr?.state).toBe('open')
    expect(pr?.mergeable).toBe('MERGEABLE')
    expect(pr?.prRepo).toEqual({ owner: 'acme', repo: 'widgets' })
    expect(pr?.headRepo).toEqual({ owner: 'acme', repo: 'widgets' })
  })

  it('resolves fork PRs from the upstream PR repo with the origin head owner', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'fork', repo: 'orca' }
      ],
      headRepo: { owner: 'fork', repo: 'orca' }
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 1738,
          title: 'Fork PR',
          state: 'open',
          html_url: 'https://github.com/stablyai/orca/pull/1738',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'clean',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        'repos/stablyai/orca/pulls?head=fork%3Afeature%2Ftest&state=all&per_page=1',
        '--include'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 1738,
      prRepo: { owner: 'stablyai', repo: 'orca' },
      headRepo: { owner: 'fork', repo: 'orca' }
    })
  })

  it('uses REST branch lookup directly when origin head repo is known', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 43,
          title: 'REST branch lookup',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/43',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable: true,
          head: { ref: 'feature/test', sha: 'rest-head-oid' },
          base: { ref: 'main', sha: 'rest-base-oid' }
        }
      ])
    })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'api',
        'repos/acme/widgets/pulls?head=acme%3Afeature%2Ftest&state=all&per_page=1',
        '--include'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 43,
      title: 'REST branch lookup',
      state: 'open',
      url: 'https://github.com/acme/widgets/pull/43',
      checksStatus: 'neutral',
      mergeable: 'MERGEABLE',
      headSha: 'rest-head-oid'
    })
  })

  // GitHub serves a renamed repository under its old name, but reports the new name in the PR.
  function primeRenamedOriginBranchLookup(headRepoName: string): void {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'old-widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 44,
          title: 'Renamed repository lookup',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/44',
          updated_at: '2026-10-28T00:00:00Z',
          draft: false,
          mergeable: true,
          head: {
            ref: 'feature/test',
            sha: 'renamed-head-oid',
            repo: { name: headRepoName, owner: { login: 'acme' } }
          },
          base: { ref: 'main', sha: 'renamed-base-oid' }
        }
      ])
    })
  }

  it('keeps a same-repository PR when origin still uses the pre-rename URL', async () => {
    primeRenamedOriginBranchLookup('widgets')

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'api',
        'repos/acme/old-widgets/pulls?head=acme%3Afeature%2Ftest&state=all&per_page=1',
        '--include'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({ number: 44, url: 'https://github.com/acme/widgets/pull/44' })
  })

  it('still rejects a cross-repository head when origin uses the pre-rename URL', async () => {
    primeRenamedOriginBranchLookup('other-widgets')

    expect(await getPRForBranch('/repo-root', 'feature/test')).toBeNull()
  })

  it('uses the current commit to discover a fork when origin is inferred as canonical', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: { owner: 'stablyai', repo: 'orca' }
    })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 12960,
            title: 'Same-name PR from another fork',
            state: 'OPEN',
            url: 'https://github.com/stablyai/orca/pull/12960',
            statusCheckRollup: [],
            updatedAt: '2026-08-09T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'fix/pr-branch-fork-lookup',
            headRefOid: 'other-head-oid',
            headRepositoryOwner: { login: 'another-fork' }
          },
          {
            number: 12956,
            title: 'Existing fork PR',
            state: 'OPEN',
            url: 'https://github.com/stablyai/orca/pull/12956',
            statusCheckRollup: [],
            updatedAt: '2026-08-08T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'fix/pr-branch-fork-lookup',
            baseRefOid: 'base-oid',
            headRefOid: 'head-oid',
            headRepositoryOwner: { login: 'dcieslak19973' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 12956,
          title: 'Hydrated fork PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/12956',
          statusCheckRollup: [],
          updatedAt: '2026-08-08T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'fix/pr-branch-fork-lookup',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })

    const pr = await getPRForBranch(
      '/repo-root',
      'fix/pr-branch-fork-lookup',
      null,
      undefined,
      null,
      {
        currentHeadOid: 'head-oid'
      }
    )

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'api',
        'repos/stablyai/orca/pulls?head=stablyai%3Afix%2Fpr-branch-fork-lookup&state=all&per_page=1',
        '--include'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([
        'pr',
        'list',
        '--repo',
        'stablyai/orca',
        '--head',
        'fix/pr-branch-fork-lookup'
      ]),
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 12956,
      title: 'Hydrated fork PR',
      prRepo: { owner: 'stablyai', repo: 'orca' },
      headRepo: { owner: 'dcieslak19973', repo: 'orca' }
    })
  })

  it('does not select an inferred fork PR when its head commit differs from the current worktree', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 12960,
          title: 'Same-name PR from another fork',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/12960',
          statusCheckRollup: [],
          updatedAt: '2026-08-09T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'fix/pr-branch-fork-lookup',
          headRefOid: 'other-head-oid',
          headRepositoryOwner: { login: 'dcieslak19973' }
        }
      ])
    })

    const result = await lookupPRByBranchName({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: { owner: 'stablyai', repo: 'orca' },
      headRepoInferred: true,
      branchName: 'fix/pr-branch-fork-lookup',
      currentHeadOid: 'head-oid',
      ghOptions: { cwd: '/repo-root' },
      executionScope: 'test'
    })

    expect(result).toMatchObject({ data: null, dataRepo: null, dataHeadRepo: null })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(ghExecFileAsyncMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(['pr', 'view']),
      expect.anything()
    )
  })

  it('does not run a broad fallback for a known head repository', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    const result = await lookupPRByBranchName({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: { owner: 'innocarpe', repo: 'orca' },
      headRepoInferred: false,
      branchName: 'fix/pr-branch-fork-lookup',
      ghOptions: { cwd: '/repo-root' },
      executionScope: 'test'
    })

    expect(result).toMatchObject({ data: null, dataRepo: null })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        'repos/stablyai/orca/pulls?head=innocarpe%3Afix%2Fpr-branch-fork-lookup&state=all&per_page=1',
        '--include'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('filters an unqualified branch-list result to the requested head owner', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 52,
            title: 'Candidate fork PR',
            state: 'OPEN',
            url: 'https://github.com/stablyai/orca/pull/52',
            statusCheckRollup: [],
            updatedAt: '2026-08-09T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'same-name',
            headRefOid: 'head-oid',
            headRepositoryOwner: { login: 'stablyai' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 52,
          title: 'Hydrated candidate PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/52',
          statusCheckRollup: [],
          updatedAt: '2026-08-09T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'same-name',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })

    const result = await lookupPRByBranchName({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null,
      headRepoInferred: false,
      branchName: 'same-name',
      ghOptions: { cwd: '/repo-root' },
      executionScope: 'test'
    })

    expect(result.data?.number).toBe(52)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining(['--head', 'same-name', '--limit', '100']),
      { cwd: '/repo-root' }
    )
  })

  it('returns inferred fallback failures as pending errors', async () => {
    const fallbackError = new Error('branch list unavailable')
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockRejectedValueOnce(fallbackError)

    const result = await lookupPRByBranchName({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: { owner: 'innocarpe', repo: 'orca' },
      headRepoInferred: true,
      branchName: 'fix/pr-branch-fork-lookup',
      currentHeadOid: 'head-oid',
      ghOptions: { cwd: '/repo-root' },
      executionScope: 'test'
    })

    expect(result).toMatchObject({ data: null, dataRepo: null, pendingError: fallbackError })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('returns null for empty branch (e.g. during rebase with detached HEAD)', async () => {
    const pr = await getPRForBranch('/repo-root', '')
    expect(pr).toBeNull()
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('returns null for refs/heads/ only branch (detached after strip)', async () => {
    const pr = await getPRForBranch('/repo-root', 'refs/heads/')
    expect(pr).toBeNull()
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('uses fallback PR number for empty branch when detached', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Detached fallback lookup',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/pull/42',
        statusCheckRollup: [],
        updatedAt: '2026-03-28T00:00:00Z',
        isDraft: false,
        mergeable: 'MERGEABLE',
        baseRefName: 'main',
        headRefName: 'feature/test',
        baseRefOid: 'base-oid',
        headRefOid: 'head-oid'
      })
    })

    const pr = await getPRForBranch('/repo-root', '', null, null, 42)

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        '42',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid,headRepositoryOwner,headRepository,isCrossRepository'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({ number: 42, title: 'Detached fallback lookup' })
  })

  it('returns null when pr list returns an empty array', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@github.com:acme/widgets.git\n' })
      .mockResolvedValueOnce({ stdout: '[]' })

    const pr = await getPRForBranch('/repo-root', 'no-pr-branch')

    expect(pr).toBeNull()
  })
})
