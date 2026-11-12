import type * as GitExecFileModule from '../git/command-runner/git-exec-file'
import type * as GhExecFileModule from '../git/command-runner/hosted-cli/gh-exec-file'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  gitExecFileAsync: clientMocks.gitExecFileAsyncMock
}))

vi.mock('../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
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
import { resetPRForBranchMocks } from './client-test-harness'
import type { RestPullRequest } from './client/lookup/pull-request-lookup-data'
import type { OwnerRepo } from './gh-utils'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock
} = clientMocks

const ACME = { owner: 'acme', repo: 'widgets' }

function primeGit(
  trackedUpstream: string,
  remoteHeads: Record<string, string> = { origin: 'develop' }
): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'for-each-ref' && args.includes('--format=%(refname)%00%(upstream)')) {
      return { stdout: `refs/heads/feature/my-change\0${trackedUpstream}\n`, stderr: '' }
    }
    if (args[0] === 'for-each-ref' && args.includes('--format=%(refname)%00%(symref)')) {
      const stdout = Object.entries(remoteHeads)
        .filter(([remote]) => args.includes(`refs/remotes/${remote}/HEA[D]`))
        .map(
          ([remote, branch]) => `refs/remotes/${remote}/HEAD\0refs/remotes/${remote}/${branch}\n`
        )
        .join('')
      return { stdout, stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { stdout: 'feature-head-oid\n', stderr: '' }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
}

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

describe('issue #26948: a branch tracking the default branch', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
    getOwnerRepoMock.mockResolvedValue(ACME)
  })

  it('does not query another GitHub server for a known public GitHub head', async () => {
    const enterprise = { ...ACME, host: 'ghe.example' }
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [enterprise, ACME],
      headRepo: ACME
    })
    primeGit('')
    primeGh({
      'acme:feature/my-change': [
        { ...restPR('feature/my-change', enterprise, enterprise), state: 'open' }
      ]
    })
    expect(await getPRForBranch('/repo-root', 'feature/my-change')).toBeNull()
    expect(
      ghExecFileAsyncMock.mock.calls.some(([, options]) => options?.host === 'ghe.example')
    ).toBe(false)
  })
})
