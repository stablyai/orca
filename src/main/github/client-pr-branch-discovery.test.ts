import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(clientMocks))
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

import { getPRForBranch, getPRForBranchOutcome } from './client'
import { resetPRForBranchMocks } from './client-test-harness'

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
      ['api', 'repos/acme/widgets/pulls?head=acme%3Afeature%2Ftest&state=all&per_page=1'],
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
      ['api', 'repos/stablyai/orca/pulls?head=fork%3Afeature%2Ftest&state=all&per_page=1'],
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
      ['api', 'repos/acme/widgets/pulls?head=acme%3Afeature%2Ftest&state=all&per_page=1'],
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

  it('returns null for empty branch (e.g. during rebase with detached HEAD)', async () => {
    const pr = await getPRForBranch('/repo-root', '')
    expect(pr).toBeNull()
    // Should not call gh at all
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
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
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

describe('getPRForBranchOutcome unresolved review comment count', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
  })

  const exactLookup = {
    number: 42,
    title: 'Fix PR discovery',
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/pull/42',
    statusCheckRollup: [],
    updatedAt: '2026-03-28T00:00:00Z',
    isDraft: false,
    mergeable: 'MERGEABLE',
    reviewDecision: null,
    mergeStateStatus: 'CLEAN',
    autoMergeRequest: null,
    baseRefName: 'main',
    headRefName: 'feature/test',
    baseRefOid: 'base-oid',
    headRefOid: 'head-oid'
  }
  const thread = (isResolved: boolean, login: string, typename = 'User') => ({
    isResolved,
    comments: { nodes: [{ author: { __typename: typename, login } }] }
  })

  function primeGhExec(): void {
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'api' && args[1]?.includes('pulls?head=')) {
        return {
          stdout: JSON.stringify([
            {
              number: 42,
              title: 'Fix PR discovery',
              state: 'open',
              html_url: exactLookup.url,
              updated_at: exactLookup.updatedAt,
              base: { ref: 'main', sha: 'base-oid' },
              head: { ref: 'feature/test', sha: 'head-oid' }
            }
          ])
        }
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        return { stdout: JSON.stringify(exactLookup) }
      }
      if (args.includes('graphql') && args.some((arg) => arg.includes('reviewThreads'))) {
        const nodes = [thread(false, 'alice'), thread(true, 'alice'), thread(false, 'ci', 'Bot')]
        return {
          stdout: JSON.stringify({
            data: { repository: { pullRequest: { reviewThreads: { nodes } } } }
          })
        }
      }
      return { stdout: '{}' }
    })
  }

  it('counts unresolved human review threads only when the hosted-review path opts in', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    primeGhExec()

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test', null, null, null, {
      includeUnresolvedReviewCommentCount: true
    })
    expect(outcome.kind === 'found' && outcome.pr.unresolvedReviewCommentCount).toBe(1)

    ghExecFileAsyncMock.mockClear()
    const plain = await getPRForBranchOutcome('/repo-root', 'feature/test')
    expect(plain.kind === 'found' && plain.pr.unresolvedReviewCommentCount).toBeUndefined()
    const askedForThreads = ghExecFileAsyncMock.mock.calls.some((call) =>
      call[0].some((arg: string) => arg.includes('reviewThreads'))
    )
    expect(askedForThreads).toBe(false)
  })
})
