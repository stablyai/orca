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
import {
  createImplicitDefaultBranchPRPolicy,
  type ImplicitDefaultBranchPRContext
} from './client/lookup/implicit-default-branch-pr'

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
    expected?: { owner: string; repo: string; host?: string } | null
    checkout?: { owner: string; repo: string }
    trackedFork?: boolean
    trackedOwner?: string
    trackedBranchMiss?: boolean
    branchResult?: boolean
    headRefName?: string
    headOwner?: string
    isCrossRepository?: boolean
  } = {}
) {
  const candidate = options.checkout ?? upstream
  resolvePRRepositoryCandidatesMock.mockResolvedValue({
    candidates: [candidate],
    headRepo: options.expected === undefined ? candidate : options.expected
  })
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'for-each-ref') {
      const branch = options.headRefName ?? 'main'
      return {
        stdout: options.trackedFork ? `refs/heads/${branch}\0fork/${branch}\n` : '',
        stderr: ''
      }
    }
    throw new Error(`Unexpected Git invocation: ${args.join(' ')}`)
  })
  if (options.trackedFork) {
    getOwnerRepoForRemoteMock.mockResolvedValue({
      ...foreign,
      owner: options.trackedOwner ?? foreign.owner
    })
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
    isCrossRepository:
      options.isCrossRepository ??
      (head ? head.owner !== upstream.owner || head.repo !== upstream.repo : undefined),
    ...(options.headOwner ? { headRepositoryOwner: { login: options.headOwner } } : {}),
    ...(head
      ? { headRepositoryOwner: { login: head.owner }, headRepository: { name: head.repo } }
      : {})
  }
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'pr' && args[1] === 'list') {
      return { stdout: JSON.stringify(options.branchResult ? [pr] : []) }
    }
    if (args[0] === 'api' && args[1].includes('/pulls?head=')) {
      return {
        stdout: JSON.stringify(
          options.branchResult && !options.trackedBranchMiss
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
                    user: pr.headRepositoryOwner,
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

  it('records branch and cached-number rejection when no repository candidate resolves', async () => {
    const branch = 'feature/topic'
    const pr = { ...primeLookup({ expected: null, headRefName: branch }), state: 'MERGED' }
    resolvePRRepositoryCandidatesMock.mockResolvedValue({ candidates: [], headRepo: null })
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'pr' && args[1] === 'view' && [branch, '7'].includes(args[2])) {
        return { stdout: JSON.stringify(pr) }
      }
      throw new Error(`Unexpected GitHub invocation: ${args.join(' ')}`)
    })

    expect(await getPRForBranchOutcome('/repo', branch, null, null, 7)).toMatchObject({
      kind: 'no-pr',
      rejectedPRUrls: [pr.url]
    })
    expect(ghExecFileAsyncMock.mock.calls.map(([args]) => args.slice(0, 3))).toEqual([
      ['pr', 'view', branch],
      ['pr', 'view', '7']
    ])
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

  it.each([undefined, 7])(
    'records foreign discovery with unknown origin and fallback %s',
    async (fallback) => {
      const pr = primeLookup({ expected: null, branchResult: true })
      expect(await getPRForBranchOutcome('/repo', 'main', null, null, fallback)).toMatchObject({
        kind: 'no-pr',
        rejectedPRUrls: [pr.url]
      })
      expect(
        ghExecFileAsyncMock.mock.calls.filter(([args]) => args[0] === 'pr' && args[1] === 'view')
      ).toHaveLength(1)
    }
  )

  it('keeps same-repository discovery when origin is unknown', async () => {
    primeLookup({ expected: null, branchResult: true, head: upstream })
    expect(await getPRForBranchOutcome('/repo', 'main')).toMatchObject({
      kind: 'found',
      pr: { number: 7, headRepo: upstream }
    })
  })

  it.each([foreign.owner, 'other-contributor'])(
    'reconsiders cached recovery after tracked-list miss for %s',
    async (trackedOwner) => {
      const pr = primeLookup({
        expected: null,
        branchResult: true,
        trackedFork: true,
        trackedOwner,
        trackedBranchMiss: true
      })
      const result = await getPRForBranchOutcome('/repo', 'main', null, null, 7)
      expect(result).toMatchObject(
        trackedOwner === foreign.owner
          ? { kind: 'found', pr: { number: 7, headRepo: foreign } }
          : { kind: 'no-pr', rejectedPRUrls: [pr.url] }
      )
      if (trackedOwner === foreign.owner) {
        expect(result).not.toHaveProperty('rejectedPRUrls')
      }
      expect(
        ghExecFileAsyncMock.mock.calls.filter(([args]) => args[0] === 'pr' && args[1] === 'view')
      ).toHaveLength(trackedOwner === foreign.owner ? 2 : 1)
    }
  )

  it('re-derives both rejected numbers and URLs when a tracked head becomes known', async () => {
    const pr = primeLookup({ expected: null })
    const context: ImplicitDefaultBranchPRContext = {
      originHeadRepo: null,
      trackedUpstream: null,
      branchName: 'main',
      repoPath: '/repo',
      localGitOptions: {},
      ghOptions: { cwd: '/repo' }
    }
    const policy = createImplicitDefaultBranchPRPolicy(context)
    expect(await policy.accepts(pr, upstream)).toBe(false)
    expect(policy.isRejected(upstream, 7)).toBe(true)
    expect([...policy.rejectedPRUrls]).toEqual([pr.url])
    context.trackedUpstream = {
      branch: { remoteName: 'fork', branchName: 'main' },
      headRepo: foreign
    }
    expect(policy.isRejected(upstream, 7)).toBe(false)
    expect([...policy.rejectedPRUrls]).toEqual([])
  })

  it('rejects a deleted foreign fork recovered through REST alone', async () => {
    const pr = primeLookup({ expected: null })
    const original = ghExecFileAsyncMock.getMockImplementation()
    ghExecFileAsyncMock.mockImplementation(async (...args) => {
      if (args[0][0] === 'pr' && args[0][1] === 'view') {
        throw new Error('HTTP 429: API rate limit exceeded')
      }
      if (args[0][0] === 'api' && args[0][1] === 'repos/acme/widgets/pulls/7') {
        return {
          stdout: JSON.stringify({
            number: 7,
            title: pr.title,
            state: 'open',
            html_url: pr.url,
            head: { ref: 'main', repo: null, user: { login: foreign.owner } }
          })
        }
      }
      return original?.(...args)
    })
    expect(await getPRForBranchOutcome('/repo', 'main', null, null, 7)).toMatchObject({
      kind: 'no-pr',
      rejectedPRUrls: [pr.url]
    })
  })

  it('does not borrow a deleted head owner from another GitHub host', async () => {
    const pr = primeLookup({
      head: null,
      headOwner: upstream.owner,
      isCrossRepository: true,
      expected: { ...upstream, host: 'github.enterprise.example' }
    })
    expect(await getPRForBranchOutcome('/repo', 'main', null, null, 7)).toMatchObject({
      kind: 'no-pr',
      rejectedPRUrls: [pr.url]
    })
  })

  it.each([upstream.owner, foreign.owner])(
    'compares surviving deleted-fork owner against GitHub origin %s',
    async (owner) => {
      const pr = primeLookup({
        head: null,
        headOwner: foreign.owner,
        isCrossRepository: true,
        expected: { owner, repo: 'widgets' }
      })
      expect(await getPRForBranchOutcome('/repo', 'main', null, null, 7)).toMatchObject(
        owner === foreign.owner
          ? { kind: 'found', pr: { number: 7 } }
          : { kind: 'no-pr', rejectedPRUrls: [pr.url] }
      )
    }
  )

  it('keeps a tracked same-repository upstream PR when origin is a fork', async () => {
    primeLookup({
      expected: foreign,
      head: upstream,
      branchResult: true,
      trackedFork: true,
      trackedOwner: upstream.owner,
      headRefName: 'feature/x'
    })
    expect(await getPRForBranchOutcome('/repo', 'feature/x')).toMatchObject({
      kind: 'found',
      pr: { number: 7, headRepo: upstream }
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
