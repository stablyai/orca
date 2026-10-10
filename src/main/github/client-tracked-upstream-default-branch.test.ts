/*
 * Issue #26948: a branch created with `git switch -c feature/x origin/develop`
 * tracks the default branch. Its PR lookup misses, falls back to the tracked
 * upstream, and attaches the newest PR whose head is `develop` (an unrelated
 * develop -> release PR), then caches that number so the link survives restarts.
 */
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

import { getPRForBranch } from './client/lookup/get-pr-for-branch'
import { getPRForBranchOutcome } from './client/lookup/pr-for-branch-outcome'
import { resetPRForBranchMocks } from './client-test-harness'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock
} = clientMocks

const ACME = { owner: 'acme', repo: 'widgets' }

/** remoteHeads maps a remote to the branch its `refs/remotes/<remote>/HEAD` points at. */
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

function restPR(headOwnerRef: string): Record<string, unknown> {
  return {
    number: 7,
    title: 'Release develop',
    state: 'closed',
    merged_at: null,
    html_url: 'https://github.com/acme/widgets/pull/7',
    updated_at: '2025-01-01T00:00:00Z',
    draft: false,
    mergeable: null,
    base: { ref: 'release', sha: 'release-oid' },
    head: { ref: headOwnerRef, sha: 'old-develop-oid' }
  }
}

/** Branch-list responses keyed by the `head=` filter; every other gh call fails. */
function primeGh(listsByHead: Record<string, Record<string, unknown>[]>): void {
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    const head = args[1]?.match(/pulls\?head=([^&]+)/)?.[1]
    if (args[0] === 'api' && head) {
      return { stdout: JSON.stringify(listsByHead[decodeURIComponent(head)] ?? []) }
    }
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === '7') {
      return {
        stdout: JSON.stringify({
          number: 7,
          title: 'Release develop',
          state: 'CLOSED',
          url: 'https://github.com/acme/widgets/pull/7',
          statusCheckRollup: [],
          updatedAt: '2025-01-01T00:00:00Z',
          isDraft: false,
          mergeable: 'UNKNOWN',
          baseRefName: 'release',
          headRefName: 'develop',
          baseRefOid: 'release-oid',
          headRefOid: 'old-develop-oid'
        })
      }
    }
    throw new Error(`gh unavailable: ${args.join(' ')}`)
  })
}

/** A fork clone: `origin` is the fork, `upstream` is the repo PRs target. */
function primeForkWithUpstream(): void {
  const UPSTREAM = { owner: 'stablyai', repo: 'widgets' }
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

  it('skips the default branch on a second remote that PRs target (fork checkout off upstream)', async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop')
    primeGh({ 'stablyai:develop': [restPR('develop')] })

    const pr = await getPRForBranch('/repo-root', 'feature/my-change')

    expect(pr).toBeNull()
  })

  it("uses the tracked remote's own default branch when it differs from origin's", async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop', { origin: 'main', upstream: 'develop' })
    primeGh({ 'stablyai:develop': [restPR('develop')] })

    const pr = await getPRForBranch('/repo-root', 'feature/my-change')

    expect(pr).toBeNull()
  })

  it("keeps a PR headed by a tracked branch that is only origin's default", async () => {
    primeForkWithUpstream()
    primeGit('refs/remotes/upstream/develop', { origin: 'develop', upstream: 'main' })
    primeGh({ 'stablyai:develop': [restPR('develop')] })

    const pr = await getPRForBranch('/repo-root', 'feature/my-change')

    expect(pr).toMatchObject({ number: 7 })
  })

  it("still follows a contributor fork's branch that shares the default branch's name", async () => {
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
      remoteName === 'contributor' ? { owner: 'contributor', repo: 'widgets' } : ACME
    )
    primeGit('refs/remotes/contributor/develop')
    primeGh({ 'contributor:develop': [{ ...restPR('develop'), state: 'open' }] })

    const pr = await getPRForBranch('/repo-root', 'feature/my-change')

    expect(pr).toMatchObject({ number: 7, headRepo: { owner: 'contributor', repo: 'widgets' } })
  })
})
