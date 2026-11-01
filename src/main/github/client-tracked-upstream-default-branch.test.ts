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
import { resetPRForBranchMocks } from './client-test-harness'
import type { RestPullRequest } from './client/lookup/pull-request-lookup-data'
import type { OwnerRepo } from './gh-utils'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock
} = clientMocks

const ACME = { owner: 'acme', repo: 'widgets' }
const UPSTREAM = { owner: 'stablyai', repo: 'widgets' }
const CONTRIBUTOR = { owner: 'contributor', repo: 'widgets' }

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

function primeForkWithUpstream(): void {
  resolvePRRepositoryCandidatesMock.mockResolvedValue({
    candidates: [UPSTREAM, ACME],
    headRepo: ACME
  })
  getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
    remoteName === 'upstream' ? UPSTREAM : remoteName === 'origin' ? ACME : null
  )
}

describe('issue #26948: a branch tracking the default branch', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
    getOwnerRepoMock.mockResolvedValue(ACME)
  })

  it('does not attach a PR whose head is the default branch', async () => {
    primeGit('refs/remotes/origin/develop')
    primeGh({ 'acme:develop': [restPR('develop')] })

    const pr = await getPRForBranch('/repo-root', 'feature/my-change')

    expect(pr).toBeNull()
  })

  it('drops a cached PR number whose head is the tracked default branch', async () => {
    primeGit('refs/remotes/origin/develop')
    primeGh({})

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/my-change', null, null, 7)

    expect(outcome.kind).toBe('no-pr')
  })

  it('identifies the rejected merged integration PR so head-current caches can clear it', async () => {
    primeGit('refs/remotes/origin/develop')
    const integrationPR = {
      ...restPR(),
      merged_at: '2025-01-02T00:00:00Z',
      head: { ...restPR().head, sha: 'feature-head-oid' }
    }
    primeGh({ 'acme:develop': [integrationPR] })

    expect(
      await getPRForBranchOutcome('/repo-root', 'feature/my-change', null, null, 7, {
        currentHeadOid: 'feature-head-oid',
        acceptMergedFallbackPR: true
      })
    ).toMatchObject({
      kind: 'no-pr',
      rejectedPRUrls: ['https://github.com/acme/widgets/pull/7']
    })
  })

  it('skips the default branch on a second remote that PRs target (fork checkout off upstream)', async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop', { origin: 'develop', upstream: 'develop' })
    primeGh({ 'stablyai:develop': [restPR('develop', UPSTREAM, UPSTREAM)] })

    const pr = await getPRForBranch('/repo-root', 'feature/my-change')

    expect(pr).toBeNull()
  })

  it("uses the tracked remote's own default branch when it differs from origin's", async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop', { origin: 'main', upstream: 'develop' })
    primeGh({ 'stablyai:develop': [restPR('develop', UPSTREAM, UPSTREAM)] })

    const pr = await getPRForBranch('/repo-root', 'feature/my-change')

    expect(pr).toBeNull()
  })

  it("keeps a PR headed by a tracked branch that is only origin's default", async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop', { origin: 'develop', upstream: 'main' })
    primeGh({ 'stablyai:develop': [restPR('develop', UPSTREAM, UPSTREAM)] })

    const pr = await getPRForBranch('/repo-root', 'feature/my-change')

    expect(pr).toMatchObject({ number: 7 })
  })

  it("still follows a contributor fork's branch that shares the default branch's name", async () => {
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
      remoteName === 'contributor' ? { owner: 'contributor', repo: 'widgets' } : ACME
    )
    primeGit('refs/remotes/contributor/develop')
    primeGh({ 'contributor:develop': [{ ...restPR('develop', CONTRIBUTOR), state: 'open' }] })

    const pr = await getPRForBranch('/repo-root', 'feature/my-change')

    expect(pr).toMatchObject({ number: 7, headRepo: { owner: 'contributor', repo: 'widgets' } })
  })

  it('preserves a cached contributor PR sharing the tracked default branch name', async () => {
    primeGit('refs/remotes/origin/develop')
    primeGh({}, { ...restPR('develop', CONTRIBUTOR), state: 'open' })
    const pr = await getPRForBranch('/repo-root', 'feature/my-change', null, null, 7)
    expect(pr).toMatchObject({ number: 7, headRepo: CONTRIBUTOR })
  })

  it('preserves a PR from the origin fork default branch into upstream', async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/origin/develop')
    primeGh({ 'acme:develop': [{ ...restPR('develop', ACME, UPSTREAM), state: 'open' }] })
    const pr = await getPRForBranch('/repo-root', 'feature/my-change')
    expect(pr).toMatchObject({ number: 7, headRepo: ACME, prRepo: UPSTREAM })
  })

  it('clears an old cached integration PR after upstream tracking is removed', async () => {
    primeGit('')
    primeGh({})
    expect(
      (await getPRForBranchOutcome('/repo-root', 'feature/my-change', null, null, 7)).kind
    ).toBe('no-pr')
  })

  it.each(['closed', 'merged'] as const)(
    'clears a cached %s integration PR in a fork after upstream tracking is removed',
    async (state) => {
      primeForkWithUpstream()
      primeGit('', { origin: 'main' })
      const integrationPR = restPR('develop', UPSTREAM, UPSTREAM)
      primeGh(
        {},
        {
          ...integrationPR,
          merged_at: state === 'merged' ? '2025-01-02T00:00:00Z' : null,
          head: {
            ...integrationPR.head,
            sha: 'feature-head-oid',
            repo: { name: 'widgets', owner: { login: 'stablyai' }, default_branch: 'develop' }
          }
        }
      )

      expect(
        await getPRForBranchOutcome('/repo-root', 'feature/my-change', null, null, 7, {
          currentHeadOid: 'feature-head-oid',
          acceptMergedFallbackPR: true
        })
      ).toMatchObject({
        kind: 'no-pr',
        rejectedPRUrls: ['https://github.com/stablyai/widgets/pull/7']
      })
    }
  )

  it('preserves a cached renamed feature PR using its own repository default metadata', async () => {
    primeForkWithUpstream()
    primeGit('', { origin: 'develop' })
    const featurePR = restPR('develop', UPSTREAM, UPSTREAM)
    primeGh(
      {},
      {
        ...featurePR,
        state: 'open',
        head: {
          ...featurePR.head,
          repo: { name: 'widgets', owner: { login: 'stablyai' }, default_branch: 'main' }
        }
      }
    )

    expect(await getPRForBranch('/repo-root', 'feature/my-change', null, null, 7)).toMatchObject({
      number: 7,
      headRefName: 'develop'
    })
  })

  it.each(['unavailable', 'changed-head'] as const)(
    'preserves an untracked cached PR when REST metadata is %s',
    async (metadataState) => {
      primeForkWithUpstream()
      primeGit('', { origin: 'develop' })
      primeGh({}, { ...restPR('develop', UPSTREAM, UPSTREAM), state: 'open' })
      const ghImplementation = ghExecFileAsyncMock.getMockImplementation()
      ghExecFileAsyncMock.mockImplementation(async (args: string[], options) => {
        if (args[0] === 'api' && args[1] === 'repos/stablyai/widgets/pulls/7') {
          if (metadataState === 'unavailable') {
            throw new Error('network unavailable')
          }
          const pr = restPR('develop', ACME, UPSTREAM)
          return {
            stdout: JSON.stringify({
              ...pr,
              head: {
                ...pr.head,
                repo: { name: 'widgets', owner: { login: 'acme' }, default_branch: 'develop' }
              }
            })
          }
        }
        return ghImplementation?.(args, options)
      })

      expect(await getPRForBranch('/repo-root', 'feature/my-change', null, null, 7)).toMatchObject({
        number: 7,
        headRepo: UPSTREAM
      })
    }
  )

  it('tries the cached feature PR after rejecting an unrelated upstream result', async () => {
    primeGit('refs/remotes/origin/develop')
    primeGh(
      { 'acme:develop': [restPR()] },
      { ...restPR('feature/my-change'), number: 8, state: 'open' }
    )
    const pr = await getPRForBranch('/repo-root', 'feature/my-change', null, null, 8)
    expect(pr).toMatchObject({ number: 8, headRefName: 'feature/my-change' })
  })

  it('does not borrow origin default when upstream HEAD is unknown', async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop', { origin: 'develop' })
    primeGh({ 'stablyai:develop': [restPR('develop', UPSTREAM, UPSTREAM)] })
    expect(await getPRForBranch('/repo-root', 'feature/my-change')).toMatchObject({ number: 7 })
  })

  it('uses PR head default metadata when upstream has no recorded HEAD', async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop', { origin: 'main' })
    const pr = restPR('develop', UPSTREAM, UPSTREAM)
    primeGh({
      'stablyai:develop': [
        {
          ...pr,
          head: {
            ...pr.head,
            repo: { name: 'widgets', owner: { login: 'stablyai' }, default_branch: 'develop' }
          }
        }
      ]
    })
    expect(await getPRForBranch('/repo-root', 'feature/my-change')).toBeNull()
  })

  it('preserves explicit links to integration PRs', async () => {
    primeGit('refs/remotes/origin/develop')
    primeGh({})
    expect(await getPRForBranch('/repo-root', 'feature/my-change', 7)).toMatchObject({ number: 7 })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('preserves cached review context while detached', async () => {
    primeGh({})
    expect(await getPRForBranch('/repo-root', '', null, null, 7)).toMatchObject({ number: 7 })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not infer a head repository for a cached PR with unavailable fork metadata', async () => {
    primeGit('refs/remotes/origin/develop')
    const pr = restPR()
    primeGh({}, { ...pr, head: { ref: 'develop', sha: 'deleted-fork-oid', repo: null } })
    expect(await getPRForBranch('/repo-root', 'feature/my-change', null, null, 7)).toMatchObject({
      number: 7
    })
  })

  it('does not fetch the rejected integration PR twice when its number is cached', async () => {
    primeGit('refs/remotes/origin/develop')
    primeGh({ 'acme:develop': [restPR()] })
    expect(await getPRForBranch('/repo-root', 'feature/my-change', null, null, 7)).toBeNull()
    const exactCalls = ghExecFileAsyncMock.mock.calls.filter(
      ([args]) => args[0] === 'pr' && args[1] === 'view'
    )
    expect(exactCalls).toHaveLength(1)
  })

  it('does not reject a cached PR because another repository rejected the same number', async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop', { origin: 'main', upstream: 'develop' })
    const unrelated = restPR('develop', UPSTREAM, UPSTREAM)
    const cached = { ...restPR('feature/my-change'), state: 'open' }
    primeGh({ 'stablyai:develop': [unrelated] }, [unrelated, cached])
    const pr = await getPRForBranch('/repo-root', 'feature/my-change', null, null, 7)
    expect(pr).toMatchObject({ number: 7, prRepo: ACME, headRefName: 'feature/my-change' })
  })

  it('continues cached number recovery after rejecting another repository default PR', async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop', { origin: 'main', upstream: 'develop' })
    primeGh({}, [
      restPR('develop', UPSTREAM, UPSTREAM),
      { ...restPR('feature/my-change'), state: 'open' }
    ])
    const pr = await getPRForBranch('/repo-root', 'feature/my-change', null, null, 7)
    expect(pr).toMatchObject({ number: 7, prRepo: ACME, headRefName: 'feature/my-change' })
  })

  it('does not accept another repository head with the same owner and branch name', async () => {
    const other = { owner: 'acme', repo: 'other-widgets' }
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [other, ACME],
      headRepo: ACME
    })
    primeGit('')
    primeGh({
      'acme:feature/my-change': [{ ...restPR('feature/my-change', other, other), state: 'open' }]
    })
    expect(await getPRForBranch('/repo-root', 'feature/my-change')).toBeNull()
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

  it('preserves a tracked contributor fork with a different repository name', async () => {
    const fork = { owner: 'contributor', repo: 'renamed-widgets' }
    getOwnerRepoForRemoteMock.mockImplementation(async (_path: string, remote: string) =>
      remote === 'contributor' ? fork : ACME
    )
    primeGit('refs/remotes/contributor/develop')
    primeGh({ 'contributor:develop': [{ ...restPR('develop', fork), state: 'open' }] })
    expect(await getPRForBranch('/repo-root', 'feature/my-change')).toMatchObject({
      number: 7,
      headRepo: fork,
      prRepo: ACME
    })
  })

  it('continues to a valid branch result after another repository returns the wrong head', async () => {
    const other = { owner: 'acme', repo: 'other-widgets' }
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [other, ACME],
      headRepo: ACME
    })
    primeGit('')
    primeGh({
      'acme:feature/my-change': [
        { ...restPR('feature/my-change', other, other), state: 'open' },
        { ...restPR('feature/my-change'), state: 'open' }
      ]
    })
    expect(await getPRForBranch('/repo-root', 'feature/my-change')).toMatchObject({
      number: 7,
      headRepo: ACME,
      prRepo: ACME
    })
  })
})
