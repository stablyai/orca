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

import { getPRForBranchOutcome } from './client/lookup/pr-for-branch-outcome'
import { linkedPRLookupRepository } from './client/lookup/linked-pr-repository'
import { resetPRForBranchMocks } from './client-test-harness'

const { ghExecFileAsyncMock, getOwnerRepoMock, resolvePRRepositoryCandidatesMock } = clientMocks

const DOCKER = { owner: 'relayto', repo: 'relayto-docker' }
const FRONTEND = { owner: 'relayto', repo: 'relayto-frontend' }

function frontendPR(state: 'OPEN' | 'MERGED') {
  return {
    number: 2383,
    title: 'Submodule change',
    state,
    url: 'https://github.com/relayto/relayto-frontend/pull/2383',
    statusCheckRollup: [],
    updatedAt: '2026-10-01T00:00:00Z',
    isDraft: false,
    mergeable: 'CONFLICTING',
    baseRefName: 'develop',
    headRefName: 'feature/frontend-only',
    baseRefOid: 'frontend-base-oid',
    headRefOid: 'bbbb2222',
    headRepositoryOwner: { login: 'relayto' },
    headRepository: { name: 'relayto-frontend' }
  }
}

/** Answers `gh pr view <n> --repo <slug>` only for the PR's own repository. */
function servePRFrom(slug: string, pr: ReturnType<typeof frontendPR>): void {
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'view' && args[args.indexOf('--repo') + 1] === slug) {
      return { stdout: JSON.stringify(pr), stderr: '' }
    }
    // An empty commit→pulls page proves "not contained", which would clear a same-repo link.
    if (args[0] === 'api' && /\/commits\/[0-9a-f]+\/pulls/.test(args[1])) {
      return { stdout: '[]', stderr: '' }
    }
    throw new Error('HTTP 404: Not Found')
  })
}

function reposQueried(): string[] {
  return ghExecFileAsyncMock.mock.calls.flatMap(([args]) =>
    Array.isArray(args) && args.includes('--repo') ? [String(args[args.indexOf('--repo') + 1])] : []
  )
}

describe('URL-linked PRs from another repository', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
    getOwnerRepoMock.mockResolvedValue(DOCKER)
  })

  it('fetches the PR from the linked repository, never the worktree remotes', async () => {
    servePRFrom('relayto/relayto-frontend', frontendPR('OPEN'))

    const outcome = await getPRForBranchOutcome('/docker', 'main', 2383, null, null, {
      linkedPRRepository: FRONTEND,
      currentHeadOid: 'aaaa1111'
    })

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: {
        number: 2383,
        state: 'open',
        url: 'https://github.com/relayto/relayto-frontend/pull/2383',
        prRepo: FRONTEND,
        headRepo: FRONTEND,
        linkedFromOtherRepository: true
      }
    })
    expect(reposQueried()).not.toContain('relayto/relayto-docker')
  })

  it('never reports another repository’s merged PR as diverged from the worktree head', async () => {
    servePRFrom('relayto/relayto-frontend', frontendPR('MERGED'))

    const outcome = await getPRForBranchOutcome('/docker', 'main', 2383, null, null, {
      linkedPRRepository: FRONTEND,
      currentHeadOid: 'aaaa1111'
    })

    expect(outcome.kind).toBe('found')
    const pr = outcome.kind === 'found' ? outcome.pr : null
    expect(pr?.state).toBe('merged')
    expect(pr?.headDivergedFromMergedPRAtOid).toBeUndefined()
    // The local checkout holds none of the other repository's commits.
    expect(pr?.conflictSummary).toBeUndefined()
    expect(clientMocks.gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('keeps the remote-candidate lookup when the URL names one of the worktree remotes', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'fork', repo: 'orca' }
      ],
      headRepo: { owner: 'fork', repo: 'orca' }
    })
    servePRFrom('fork/orca', {
      ...frontendPR('OPEN'),
      url: 'https://github.com/fork/orca/pull/2383'
    })

    const outcome = await getPRForBranchOutcome('/orca', 'feature', 2383, null, null, {
      linkedPRRepository: { owner: 'stablyai', repo: 'orca' }
    })

    expect(reposQueried().slice(0, 2)).toEqual(['stablyai/orca', 'fork/orca'])
    expect(outcome.kind === 'found' && outcome.pr.linkedFromOtherRepository).toBeFalsy()
  })

  it.each([
    ['another GitHub host', { ...FRONTEND, host: 'ghe.example.com' }],
    ['a malformed owner', { owner: 'not an owner', repo: 'relayto-frontend' }]
  ])(
    'reports no PR for a link to %s instead of the row repo’s same number',
    async (_label, linkedPRRepository) => {
      servePRFrom('relayto/relayto-docker', {
        ...frontendPR('OPEN'),
        url: 'https://github.com/relayto/relayto-docker/pull/2383'
      })

      const outcome = await getPRForBranchOutcome('/docker', 'main', 2383, null, null, {
        linkedPRRepository
      })

      expect(outcome.kind).toBe('no-pr')
      expect(reposQueried()).toEqual([])
    }
  )

  it('does not coalesce the same PR number linked from two repositories', async () => {
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const slug = args[args.indexOf('--repo') + 1]
      const [owner, repo] = slug.split('/')
      return {
        stdout: JSON.stringify({
          ...frontendPR('OPEN'),
          url: `https://github.com/${slug}/pull/2383`,
          headRepositoryOwner: { login: owner },
          headRepository: { name: repo }
        }),
        stderr: ''
      }
    })

    const [frontend, api] = await Promise.all([
      getPRForBranchOutcome('/docker', 'main', 2383, null, null, { linkedPRRepository: FRONTEND }),
      getPRForBranchOutcome('/docker', 'main', 2383, null, null, {
        linkedPRRepository: { owner: 'relayto', repo: 'relayto-api' }
      })
    ])

    expect(frontend.kind === 'found' && frontend.pr.url).toBe(
      'https://github.com/relayto/relayto-frontend/pull/2383'
    )
    expect(api.kind === 'found' && api.pr.url).toBe(
      'https://github.com/relayto/relayto-api/pull/2383'
    )
  })
})

describe('linkedPRLookupRepository', () => {
  it.each([
    ['a repository outside the remotes', FRONTEND, [DOCKER], FRONTEND],
    ['a remote (any case)', { owner: 'Relayto', repo: 'Relayto-Docker' }, [DOCKER], null],
    ['an explicit github.com host', { ...FRONTEND, host: 'github.com' }, [DOCKER], FRONTEND],
    [
      'the remote’s Enterprise host',
      { ...FRONTEND, host: 'GHE.example.com' },
      [{ ...DOCKER, host: 'ghe.example.com' }],
      { ...FRONTEND, host: 'ghe.example.com' }
    ],
    ['a host none of the remotes use', { ...FRONTEND, host: 'evil.example' }, [DOCKER], 'refused'],
    ['a worktree with no GitHub remote', FRONTEND, [], 'refused'],
    ['no link (bare number)', null, [DOCKER], null]
  ])('%s', (_label, linkedPRRepository, candidates, expected) => {
    expect(linkedPRLookupRepository(2383, { linkedPRRepository }, candidates)).toEqual(expected)
  })

  it('applies only to an exact linked number', () => {
    expect(linkedPRLookupRepository(null, { linkedPRRepository: FRONTEND }, [DOCKER])).toBeNull()
  })
})
