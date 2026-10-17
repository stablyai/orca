// A branch's PR is the one whose head is where the branch is pushed (#28324, #27811, #26948).
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
import type { RestPullRequest } from './client/lookup/pull-request-lookup-data'
import type { OwnerRepo } from './gh-utils'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  gitConfigListMock,
  gitExecFileAsyncMock
} = clientMocks

const ACME = { owner: 'acme', repo: 'widgets' }
const UPSTREAM = { owner: 'stablyai', repo: 'widgets' }
const CONTRIBUTOR = { owner: 'contributor', repo: 'widgets' }

function restPR(
  headRefName = 'develop',
  headRepo: OwnerRepo = ACME,
  prRepo: OwnerRepo = ACME
): RestPullRequest {
  return {
    number: 7,
    title: 'Release develop',
    state: 'closed',
    merged_at: null,
    html_url: `https://${prRepo.host ?? 'github.com'}/${prRepo.owner}/${prRepo.repo}/pull/7`,
    updated_at: '2025-01-01T00:00:00Z',
    draft: false,
    mergeable: null,
    base: { ref: 'release', sha: 'release-oid' },
    head: {
      ref: headRefName,
      sha: 'old-develop-oid',
      repo: { name: headRepo.repo, owner: { login: headRepo.owner } }
    }
  }
}

function primeGh(
  listsByHead: Record<string, RestPullRequest[]>,
  exactPR: RestPullRequest | RestPullRequest[] = Object.values(listsByHead).flat()[0] ?? restPR()
): void {
  const repositorySlug = (pr: RestPullRequest): string =>
    new URL(pr.html_url ?? '').pathname.split('/').slice(1, 3).join('/')
  const repositoryHost = (pr: RestPullRequest): string => new URL(pr.html_url ?? '').host
  const exactPRs = Array.isArray(exactPR) ? exactPR : [exactPR]
  const prsByRepositoryAndNumber = new Map(
    [...Object.values(listsByHead).flat(), ...exactPRs].map((pr) => [
      `${repositoryHost(pr)}/${repositorySlug(pr)}#${pr.number}`,
      pr
    ])
  )
  ghExecFileAsyncMock.mockImplementation(
    async (args: string[], options: { host?: string } = {}) => {
      const host = options.host ?? 'github.com'
      const match = args[1]?.match(/^repos\/([^/]+\/[^/]+)\/pulls\?head=([^&]+)/)
      if (args[0] === 'api' && match) {
        const list = (listsByHead[decodeURIComponent(match[2])] ?? []).filter(
          (pr) => repositoryHost(pr) === host && repositorySlug(pr) === match[1]
        )
        return { stdout: JSON.stringify(list) }
      }
      const exactRestMatch = args[1]?.match(/^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/)
      if (args[0] === 'api' && exactRestMatch) {
        const pr = prsByRepositoryAndNumber.get(`${host}/${exactRestMatch[1]}#${exactRestMatch[2]}`)
        if (pr) {
          return { stdout: JSON.stringify(pr) }
        }
        throw new Error('HTTP 404 Not Found')
      }
      const repoIndex = args.indexOf('--repo')
      const exact = prsByRepositoryAndNumber.get(`${host}/${args[repoIndex + 1]}#${args[2]}`)
      if (args[0] === 'pr' && args[1] === 'view') {
        if (!exact) {
          throw new Error('HTTP 404 Not Found')
        }
        return {
          stdout: JSON.stringify({
            number: exact.number,
            title: exact.title,
            state: exact.merged_at ? 'MERGED' : exact.state.toUpperCase(),
            url: exact.html_url,
            statusCheckRollup: [],
            updatedAt: exact.updated_at,
            isDraft: exact.draft,
            mergeable: 'UNKNOWN',
            baseRefName: exact.base?.ref,
            headRefName: exact.head?.ref,
            baseRefOid: exact.base?.sha,
            headRefOid: exact.head?.sha,
            headRepositoryOwner: exact.head?.repo?.owner,
            headRepository: exact.head?.repo ? { name: exact.head.repo.name } : null
          })
        }
      }
      throw new Error(`gh unavailable: ${args.join(' ')}`)
    }
  )
}

/** A fork clone: `origin` is the fork, `upstream` is the repo PRs target. */
function primeForkWithUpstream(): void {
  resolvePRRepositoryCandidatesMock.mockResolvedValue({
    candidates: [UPSTREAM, ACME],
    headRepo: ACME
  })
  getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
    remoteName === 'upstream' ? UPSTREAM : remoteName === 'origin' ? ACME : null
  )
}

const BRANCH = 'feature/my-change'

/** The branch's push config, as `git config --list -z` reports it, plus HEAD and origin's default branch. */
function primeBranchConfig(records: [string, string][] = []): void {
  gitConfigListMock.mockResolvedValue(gitConfigListOutput(records))
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'for-each-ref' && args.includes('--format=%(refname)%00%(symref)')) {
      return { stdout: 'refs/remotes/origin/HEAD\0refs/remotes/origin/main\n', stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { stdout: 'feature-head-oid\n', stderr: '' }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
}

function tracking(remote: string, branch: string): [string, string][] {
  return [
    [`branch.${BRANCH}.remote`, remote],
    [`branch.${BRANCH}.merge`, `refs/heads/${branch}`]
  ]
}

describe('a branch PR is matched by where the branch is pushed', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
    getOwnerRepoMock.mockResolvedValue(ACME)
  })

  it('shows the open PR over a newer closed one on the same head (#28324)', async () => {
    primeBranchConfig(tracking('origin', BRANCH))
    primeGh(
      {
        [`acme:${BRANCH}`]: [
          { ...restPR(BRANCH), number: 8, html_url: 'https://github.com/acme/widgets/pull/8' },
          { ...restPR(BRANCH), state: 'open' }
        ]
      },
      [{ ...restPR(BRANCH), state: 'open' }]
    )

    expect(await getPRForBranch('/repo-root', BRANCH)).toMatchObject({ number: 7, state: 'open' })
  })

  it('asks for open PRs when ten newer closed PRs fill the first page', async () => {
    primeBranchConfig(tracking('origin', BRANCH))
    const closed = Array.from({ length: 10 }, (_, i) => ({
      ...restPR(BRANCH),
      number: 20 - i,
      html_url: `https://github.com/acme/widgets/pull/${20 - i}`
    }))
    const open = { ...restPR(BRANCH), state: 'open' }
    primeGh({ [`acme:${BRANCH}`]: [...closed, open] }, [open])
    const listCall = ghExecFileAsyncMock.getMockImplementation()
    ghExecFileAsyncMock.mockImplementation(async (args: string[], options) => {
      if (args[0] === 'api' && args[1]?.includes('state=all')) {
        return { stdout: JSON.stringify(closed) }
      }
      return listCall?.(args, options)
    })

    expect(await getPRForBranch('/repo-root', BRANCH)).toMatchObject({ number: 7, state: 'open' })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        `repos/acme/widgets/pulls?head=acme%3A${encodeURIComponent(BRANCH)}&state=open&per_page=10`
      ],
      expect.anything()
    )
  })

  it("does not attach another owner's PR from a same-named branch (#27811)", async () => {
    primeBranchConfig(tracking('origin', BRANCH))
    primeGh({ [`contributor:${BRANCH}`]: [{ ...restPR(BRANCH, CONTRIBUTOR), state: 'open' }] })

    expect(await getPRForBranch('/repo-root', BRANCH)).toBeNull()
  })

  it('does not attach the PR of the base branch the branch tracks (#26948)', async () => {
    primeBranchConfig(tracking('origin', 'develop'))
    primeGh({ 'acme:develop': [restPR('develop')] })

    expect(await getPRForBranch('/repo-root', BRANCH)).toBeNull()
  })

  it('does not attach the PR of an upstream base branch in a fork checkout', async () => {
    primeForkWithUpstream()
    primeBranchConfig(tracking('upstream', 'develop'))
    primeGh({ 'stablyai:develop': [{ ...restPR('develop', UPSTREAM, UPSTREAM), state: 'open' }] })

    expect(await getPRForBranch('/repo-root', BRANCH)).toBeNull()
  })

  it('drops a remembered integration PR whose head commit matches but whose head is not this branch', async () => {
    primeBranchConfig(tracking('origin', 'develop'))
    const integrationPR = {
      ...restPR(),
      merged_at: '2025-01-02T00:00:00Z',
      head: { ...restPR().head, sha: 'feature-head-oid' }
    }
    primeGh({ 'acme:develop': [integrationPR] })

    expect(
      await getPRForBranchOutcome('/repo-root', BRANCH, null, null, 7, {
        currentHeadOid: 'feature-head-oid',
        acceptMergedFallbackPR: true
      })
    ).toMatchObject({ kind: 'no-pr', rejectedPRUrls: ['https://github.com/acme/widgets/pull/7'] })
  })

  it('keeps a remembered PR whose head is this branch', async () => {
    primeBranchConfig()
    primeGh({}, { ...restPR(BRANCH), state: 'open' })

    expect(await getPRForBranch('/repo-root', BRANCH, null, null, 7)).toMatchObject({
      number: 7,
      headRefName: BRANCH
    })
  })

  it('keeps a remembered PR from a deleted fork when the branch name matches', async () => {
    primeBranchConfig()
    primeGh({}, { ...restPR(BRANCH), state: 'open', head: { ref: BRANCH, sha: 'oid', repo: null } })

    expect(await getPRForBranch('/repo-root', BRANCH, null, null, 7)).toMatchObject({ number: 7 })
  })

  it("follows a contributor fork's branch checked out under a local name", async () => {
    const fork = { owner: 'contributor', repo: 'renamed-widgets' }
    getOwnerRepoForRemoteMock.mockImplementation(async (_path: string, remote: string) =>
      remote === 'contributor' ? fork : ACME
    )
    primeBranchConfig(tracking('contributor', 'develop'))
    primeGh({ 'contributor:develop': [{ ...restPR('develop', fork), state: 'open' }] })

    expect(await getPRForBranch('/repo-root', BRANCH)).toMatchObject({
      number: 7,
      headRepo: fork,
      prRepo: ACME
    })
  })

  it('finds a fork PR into upstream when the branch is pushed to the fork', async () => {
    primeForkWithUpstream()
    primeBranchConfig(tracking('origin', BRANCH))
    primeGh({ [`acme:${BRANCH}`]: [{ ...restPR(BRANCH, ACME, UPSTREAM), state: 'open' }] })

    expect(await getPRForBranch('/repo-root', BRANCH)).toMatchObject({
      number: 7,
      headRepo: ACME,
      prRepo: UPSTREAM
    })
  })

  it('follows the push remote when it differs from the tracked one (triangular)', async () => {
    getOwnerRepoForRemoteMock.mockImplementation(async (_path: string, remote: string) =>
      remote === 'fork' ? CONTRIBUTOR : ACME
    )
    primeBranchConfig([...tracking('origin', 'main'), [`branch.${BRANCH}.pushremote`, 'fork']])
    primeGh({ [`contributor:${BRANCH}`]: [{ ...restPR(BRANCH, CONTRIBUTOR), state: 'open' }] })

    expect(await getPRForBranch('/repo-root', BRANCH)).toMatchObject({
      number: 7,
      headRepo: CONTRIBUTOR
    })
  })

  it('treats a branch checked out from refs/pull/N/head as linked to PR N', async () => {
    primeBranchConfig([
      [`branch.${BRANCH}.remote`, 'origin'],
      [`branch.${BRANCH}.merge`, 'refs/pull/7/head']
    ])
    primeGh({}, { ...restPR('contributor-branch', CONTRIBUTOR), state: 'open' })

    expect(await getPRForBranch('/repo-root', BRANCH)).toMatchObject({ number: 7 })
  })

  it('keeps an explicit link without reading git config', async () => {
    primeBranchConfig(tracking('origin', 'develop'))
    primeGh({})

    expect(await getPRForBranch('/repo-root', BRANCH, 7)).toMatchObject({ number: 7 })
    expect(gitConfigListMock).not.toHaveBeenCalled()
  })

  it('keeps a remembered PR while detached', async () => {
    primeGh({})

    expect(await getPRForBranch('/repo-root', '', null, null, 7)).toMatchObject({ number: 7 })
    expect(gitConfigListMock).not.toHaveBeenCalled()
  })

  it('does not accept another repository head with the same owner and branch name', async () => {
    const other = { owner: 'acme', repo: 'other-widgets' }
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [other, ACME],
      headRepo: ACME
    })
    primeBranchConfig()
    primeGh({ [`acme:${BRANCH}`]: [{ ...restPR(BRANCH, other, other), state: 'open' }] })

    expect(await getPRForBranch('/repo-root', BRANCH)).toBeNull()
  })

  it('does not query another GitHub server for a public GitHub head', async () => {
    const enterprise = { ...ACME, host: 'ghe.example' }
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [enterprise, ACME],
      headRepo: ACME
    })
    primeBranchConfig()
    primeGh({ [`acme:${BRANCH}`]: [{ ...restPR(BRANCH, enterprise, enterprise), state: 'open' }] })

    expect(await getPRForBranch('/repo-root', BRANCH)).toBeNull()
    expect(
      ghExecFileAsyncMock.mock.calls.some(([, options]) => options?.host === 'ghe.example')
    ).toBe(false)
  })
})
