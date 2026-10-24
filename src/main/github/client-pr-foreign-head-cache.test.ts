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
import { resetPRForBranchMocks } from './client-test-harness'

const {
  ghExecFileAsyncMock,
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock,
  getOwnerRepoForRemoteMock
} = clientMocks

const upstream = { owner: 'acme', repo: 'widgets' }
const foreign = { owner: 'contributor', repo: 'widgets' }

function primeLookup(
  options: {
    head?: { owner: string; repo: string } | null
    expected?: { owner: string; repo: string } | null
    checkout?: { owner: string; repo: string }
    trackedFork?: boolean
    branchResult?: boolean
    headRefName?: string
  } = {}
) {
  const candidate = options.checkout ?? upstream
  resolvePRRepositoryCandidatesMock.mockResolvedValue({
    candidates: [candidate],
    headRepo: options.expected === undefined ? candidate : options.expected
  })
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'for-each-ref') {
      return { stdout: options.trackedFork ? 'refs/heads/main\0fork/main\n' : '', stderr: '' }
    }
    throw new Error(`Unexpected Git invocation: ${args.join(' ')}`)
  })
  if (options.trackedFork) {
    getOwnerRepoForRemoteMock.mockResolvedValue(foreign)
  }
  const head = options.head === undefined ? foreign : options.head
  const pr = {
    number: 7,
    title: 'A pull request on main',
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/pull/7',
    updatedAt: '2026-10-22T00:00:00Z',
    statusCheckRollup: [],
    isDraft: false,
    mergeable: 'MERGEABLE',
    baseRefName: 'release',
    headRefName: options.headRefName ?? 'main',
    headRefOid: 'foreign-head',
    ...(head
      ? { headRepositoryOwner: { login: head.owner }, headRepository: { name: head.repo } }
      : {})
  }
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'api' && args[1].includes('/pulls?head=')) {
      return {
        stdout: JSON.stringify(
          options.branchResult
            ? [
                {
                  number: pr.number,
                  title: pr.title,
                  state: 'open',
                  html_url: pr.url,
                  updated_at: pr.updatedAt,
                  base: { ref: pr.baseRefName },
                  head: {
                    ref: pr.headRefName,
                    sha: pr.headRefOid,
                    repo: head ? { name: head.repo, owner: { login: head.owner } } : null
                  }
                }
              ]
            : []
        )
      }
    }
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === '7') {
      return { stdout: JSON.stringify(pr) }
    }
    throw new Error(`Unexpected GitHub invocation: ${args.join(' ')}`)
  })
  return pr
}

describe('cached pull request head repository identity', () => {
  beforeEach(() => resetPRForBranchMocks(clientMocks))

  it.each(['main', 'feature/local'])('rejects a foreign fork cached for %s', async (branch) => {
    const pr = primeLookup({ headRefName: branch })
    expect(await getPRForBranchOutcome('/repo', branch, null, null, 7)).toMatchObject({
      kind: 'no-pr',
      rejectedPRUrls: [pr.url]
    })
  })

  it('rejects a different repository owned by the same account', async () => {
    const pr = primeLookup({ head: { owner: 'acme', repo: 'other-project' } })
    expect(await getPRForBranchOutcome('/repo', 'main', null, null, 7)).toMatchObject({
      kind: 'no-pr',
      rejectedPRUrls: [pr.url]
    })
  })

  it('cannot recover a rejected branch result through its cached number', async () => {
    const pr = primeLookup({ branchResult: true })
    expect(await getPRForBranchOutcome('/repo', 'main', null, null, 7)).toMatchObject({
      kind: 'no-pr',
      rejectedPRUrls: [pr.url]
    })
  })

  it('keeps a cached PR from the checkout repository', async () => {
    primeLookup({ head: upstream })
    expect(await getPRForBranchOutcome('/repo', 'main', null, null, 7)).toMatchObject({
      kind: 'found',
      pr: { number: 7, headRepo: upstream }
    })
  })

  it('keeps a cached PR belonging to the tracked fork after branch discovery misses', async () => {
    primeLookup({ trackedFork: true })
    expect(await getPRForBranchOutcome('/repo', 'main', null, null, 7)).toMatchObject({
      kind: 'found',
      pr: { number: 7, headRepo: foreign }
    })
  })

  it('keeps an explicitly linked cross-fork PR', async () => {
    primeLookup()
    expect(await getPRForBranchOutcome('/repo', 'main', 7)).toMatchObject({
      kind: 'found',
      pr: { number: 7, headRepo: foreign }
    })
  })

  it('preserves cached recovery for a renamed local review branch', async () => {
    primeLookup()
    expect(await getPRForBranchOutcome('/repo', 'review/local', null, null, 7)).toMatchObject({
      kind: 'found',
      pr: { number: 7, headRepo: foreign }
    })
  })

  it('preserves recovery when head repository metadata is unavailable', async () => {
    primeLookup({ head: null })
    expect(await getPRForBranchOutcome('/repo', 'main', null, null, 7)).toMatchObject({
      kind: 'found',
      pr: { number: 7 }
    })
  })

  it('preserves recovery when the checkout head repository is unknown', async () => {
    primeLookup({ expected: null })
    expect(await getPRForBranchOutcome('/repo', 'main', null, null, 7)).toMatchObject({
      kind: 'found',
      pr: { number: 7, headRepo: foreign }
    })
  })

  it('keeps a same-repository PR when origin still uses the pre-rename URL', async () => {
    primeLookup({ head: upstream, checkout: { owner: 'acme', repo: 'old-widgets' } })
    expect(await getPRForBranchOutcome('/repo', 'main', null, null, 7)).toMatchObject({
      kind: 'found',
      pr: { number: 7, headRepo: upstream }
    })
  })
})
