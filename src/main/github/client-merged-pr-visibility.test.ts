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

import { getPRForBranchOutcome, getPRForBranch } from './client'
import { resetPRForBranchMocks } from './client-test-harness'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  resolvePRRepositoryCandidatesMock,
  gitExecFileAsyncMock,
  rateLimitGuardMock
} = clientMocks

describe('getPRForBranch', () => {
  beforeEach(() => {
    resetPRForBranchMocks(clientMocks)
  })

  it('ignores merged PRs discovered only by branch lookup when the branch moved on', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 5511,
            title: 'Merged branch PR',
            state: 'closed',
            merged_at: '2026-06-16T17:15:33Z',
            html_url: 'https://github.com/stablyai/orca/pull/5511',
            updated_at: '2026-06-16T17:15:33Z',
            draft: false,
            mergeable_state: 'clean',
            head: { ref: 'add-guide-for-mobile-emulator-use', sha: 'head-oid' },
            base: { ref: 'main', sha: 'base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5511,
          title: 'Merged branch PR',
          state: 'MERGED',
          url: 'https://github.com/stablyai/orca/pull/5511',
          statusCheckRollup: [],
          updatedAt: '2026-06-16T17:15:33Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'add-guide-for-mobile-emulator-use',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'new-local-head-oid\n',
      stderr: ''
    })

    const pr = await getPRForBranch('/repo-root', 'add-guide-for-mobile-emulator-use')

    expect(pr).toBeNull()
  })

  it('shows a merged branch PR when it still matches the current HEAD', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 5875,
            title: 'Merged current branch PR',
            state: 'closed',
            merged_at: '2026-06-20T04:53:05Z',
            html_url: 'https://github.com/acme/widgets/pull/5875',
            updated_at: '2026-06-20T04:53:05Z',
            draft: false,
            mergeable_state: 'clean',
            head: { ref: 'fix-tab-strip-layout-test', sha: 'current-head-oid' },
            base: { ref: 'main', sha: 'base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5875,
          title: 'Merged current branch PR',
          state: 'MERGED',
          url: 'https://github.com/acme/widgets/pull/5875',
          statusCheckRollup: [],
          updatedAt: '2026-06-20T04:53:05Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'fix-tab-strip-layout-test',
          baseRefOid: 'base-oid',
          headRefOid: 'current-head-oid'
        })
      })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'current-head-oid\n',
      stderr: ''
    })

    const pr = await getPRForBranch('/repo-root', 'fix-tab-strip-layout-test')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['rev-parse', 'HEAD'], {
      cwd: '/repo-root'
    })
    expect(pr).toMatchObject({
      number: 5875,
      title: 'Merged current branch PR',
      state: 'merged',
      headSha: 'current-head-oid'
    })
  })

  const mockMergedBranchPRLookupBehindHead = (prNumber = 6011): void => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: prNumber,
            title: 'Merged PR with unpulled final head',
            state: 'closed',
            merged_at: '2026-07-03T21:27:36Z',
            html_url: `https://github.com/acme/widgets/pull/${prNumber}`,
            updated_at: '2026-07-03T21:27:36Z',
            draft: false,
            mergeable_state: 'clean',
            head: { ref: 'fix-hibernation-wake', sha: 'aaaa1111aaaa1111' },
            base: { ref: 'main', sha: 'base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: prNumber,
          title: 'Merged PR with unpulled final head',
          state: 'MERGED',
          url: `https://github.com/acme/widgets/pull/${prNumber}`,
          statusCheckRollup: [],
          updatedAt: '2026-07-03T21:27:36Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'fix-hibernation-wake',
          baseRefOid: 'base-oid',
          headRefOid: 'aaaa1111aaaa1111'
        })
      })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'bbbb2222bbbb2222\n',
      stderr: ''
    })
  }

  it('shows a merged branch PR when the worktree head is one of its own commits', async () => {
    mockMergedBranchPRLookupBehindHead()
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ number: 6011 }, { number: 42 }])
    })

    const pr = await getPRForBranch('/repo-root', 'fix-hibernation-wake')

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['api', 'repos/acme/widgets/commits/bbbb2222bbbb2222/pulls?per_page=100&page=1'],
      expect.anything()
    )
    expect(pr).toMatchObject({
      number: 6011,
      state: 'merged',
      headSha: 'aaaa1111aaaa1111',
      confirmedContainedHeadOid: 'bbbb2222bbbb2222'
    })
  })

  it('keeps hiding a merged branch PR when the head belongs to a different PR (reused branch)', async () => {
    mockMergedBranchPRLookupBehindHead()
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ number: 42 }])
    })

    const pr = await getPRForBranch('/repo-root', 'fix-hibernation-wake')

    expect(pr).toBeNull()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)

    // A definitive "not part of this PR" answer is immutable for a merged PR:
    // repeated polls must not re-probe GitHub.
    mockMergedBranchPRLookupBehindHead()
    const second = await getPRForBranch('/repo-root', 'fix-hibernation-wake')

    expect(second).toBeNull()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(5)
  })

  it('keeps hiding a merged branch PR when the commit membership probe fails', async () => {
    mockMergedBranchPRLookupBehindHead()
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 422: No commit found'))

    const pr = await getPRForBranch('/repo-root', 'fix-hibernation-wake')

    expect(pr).toBeNull()
  })

  it('skips the membership probe while the core rate-limit budget is blocked', async () => {
    mockMergedBranchPRLookupBehindHead()
    rateLimitGuardMock.mockImplementation((bucket?: string) =>
      bucket === 'core'
        ? { blocked: true, remaining: 0, limit: 5000, resetAt: 0 }
        : { blocked: false }
    )

    const pr = await getPRForBranch('/repo-root', 'fix-hibernation-wake')

    expect(pr).toBeNull()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('reuses the cached membership answer instead of re-querying per poll', async () => {
    mockMergedBranchPRLookupBehindHead()
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ number: 6011 }])
    })
    const first = await getPRForBranch('/repo-root', 'fix-hibernation-wake')
    expect(first).toMatchObject({ number: 6011, confirmedContainedHeadOid: 'bbbb2222bbbb2222' })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)

    mockMergedBranchPRLookupBehindHead()
    const second = await getPRForBranch('/repo-root', 'fix-hibernation-wake')

    expect(second).toMatchObject({ number: 6011, confirmedContainedHeadOid: 'bbbb2222bbbb2222' })
    // No fourth membership call: the confirmed answer is immutable and cached.
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(5)
  })

  it('uses the caller-supplied worktree head for the membership probe without shelling out', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 6012,
            title: 'Merged PR queried by checks panel',
            state: 'closed',
            merged_at: '2026-07-03T21:27:36Z',
            html_url: 'https://github.com/acme/widgets/pull/6012',
            updated_at: '2026-07-03T21:27:36Z',
            draft: false,
            mergeable_state: 'clean',
            head: { ref: 'fix-hibernation-wake', sha: 'aaaa1111aaaa1111' },
            base: { ref: 'main', sha: 'base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 6012,
          title: 'Merged PR queried by checks panel',
          state: 'MERGED',
          url: 'https://github.com/acme/widgets/pull/6012',
          statusCheckRollup: [],
          updatedAt: '2026-07-03T21:27:36Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'fix-hibernation-wake',
          baseRefOid: 'base-oid',
          headRefOid: 'aaaa1111aaaa1111'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ number: 6012 }])
      })

    const outcome = await getPRForBranchOutcome(
      '/repo-root',
      'fix-hibernation-wake',
      null,
      null,
      null,
      {
        currentHeadOid: 'cccc3333cccc3333'
      }
    )

    // Why: the merged-implicit head probe must use the supplied oid — no
    // `rev-parse HEAD` shell-out. (The #9171 guard may still probe the repo
    // default branch for this non-open implicit result; that is unrelated.)
    expect(
      gitExecFileAsyncMock.mock.calls.some(
        (call) => call[0][0] === 'rev-parse' && call[0][1] === 'HEAD'
      )
    ).toBe(false)
    expect(outcome).toMatchObject({
      kind: 'found',
      pr: {
        number: 6012,
        headRefName: 'fix-hibernation-wake',
        confirmedContainedHeadOid: 'cccc3333cccc3333'
      }
    })
  })

  function mockMergedLinkedPRLookup(prNumber = 7447) {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: prNumber,
        title: 'Merged linked PR',
        state: 'MERGED',
        url: `https://github.com/acme/widgets/pull/${prNumber}`,
        statusCheckRollup: [],
        updatedAt: '2026-07-03T21:27:36Z',
        isDraft: false,
        mergeable: 'MERGEABLE',
        baseRefName: 'main',
        headRefName: 'old-linked-branch',
        baseRefOid: 'base-oid',
        headRefOid: 'aaaa1111aaaa1111'
      })
    })
  }

  it('stamps confirmedContainedHeadOid for a linked merged PR when HEAD is its commit', async () => {
    mockMergedLinkedPRLookup()
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ number: 7447 }])
    })

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: {
        number: 7447,
        state: 'merged',
        confirmedContainedHeadOid: 'bbbb2222bbbb2222'
      }
    })
    expect(outcome.kind === 'found' ? outcome.pr.headDivergedFromMergedPRAtOid : undefined).toBe(
      undefined
    )
  })

  it('stamps headDivergedFromMergedPRAtOid for a linked merged PR with a definite miss', async () => {
    mockMergedLinkedPRLookup()
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ number: 42 }])
    })

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: {
        number: 7447,
        state: 'merged',
        headDivergedFromMergedPRAtOid: 'bbbb2222bbbb2222'
      }
    })
  })

  it('stamps linked merged divergence when a later membership page proves absence', async () => {
    mockMergedLinkedPRLookup()
    // Page 1 is full and omits the linked PR (truncated), but page 2 is short and
    // still omits it — that pair definitively proves the head is not contained.
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ number: 1000 + index }))
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify(fullPage) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 2000 }]) })

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: { number: 7447, state: 'merged', headDivergedFromMergedPRAtOid: 'bbbb2222bbbb2222' }
    })
  })

  it('leaves linked merged divergence unset when membership pages stay full to the cap', async () => {
    mockMergedLinkedPRLookup()
    // Every page up to the cap is full and omits the linked PR, so absence can
    // never be proven — the probe must stay unknown rather than clear the link.
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ number: 1000 + index }))
    for (let page = 0; page < 5; page += 1) {
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: JSON.stringify(fullPage) })
    }

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({ kind: 'found', pr: { number: 7447, state: 'merged' } })
    expect(outcome.kind === 'found' ? outcome.pr.headDivergedFromMergedPRAtOid : undefined).toBe(
      undefined
    )
  })

  it('stamps linked merged divergence via the PR url when no repo candidates resolve', async () => {
    // Fallback path: no resolved candidates, so `gh pr view` returns the PR with
    // dataRepo=null. The membership probe must still run against the repo derived
    // from the PR's own URL so a diverged merged linked PR can clear.
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({ candidates: [], headRepo: null })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 7447,
          title: 'Merged linked PR',
          state: 'MERGED',
          url: 'https://github.com/acme/widgets/pull/7447',
          statusCheckRollup: [],
          updatedAt: '2026-07-03T21:27:36Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'old-linked-branch',
          baseRefOid: 'base-oid',
          headRefOid: 'aaaa1111aaaa1111'
        })
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 2000 }]) })

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: { number: 7447, state: 'merged', headDivergedFromMergedPRAtOid: 'bbbb2222bbbb2222' }
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'repos/acme/widgets/commits/bbbb2222bbbb2222/pulls?per_page=100&page=1'],
      expect.anything()
    )
  })

  it('leaves linked merged divergence unset when the membership probe is rate-limited', async () => {
    mockMergedLinkedPRLookup()
    rateLimitGuardMock.mockImplementation((bucket?: string) =>
      bucket === 'core'
        ? { blocked: true, remaining: 0, limit: 5000, resetAt: 0 }
        : { blocked: false }
    )

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({ kind: 'found', pr: { number: 7447, state: 'merged' } })
    expect(outcome.kind === 'found' ? outcome.pr.headDivergedFromMergedPRAtOid : undefined).toBe(
      undefined
    )
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('leaves linked merged divergence unset when the membership probe throws', async () => {
    mockMergedLinkedPRLookup()
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 422: No commit found'))

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({ kind: 'found', pr: { number: 7447, state: 'merged' } })
    expect(outcome.kind === 'found' ? outcome.pr.headDivergedFromMergedPRAtOid : undefined).toBe(
      undefined
    )
  })

  it('leaves linked merged divergence unset when the membership probe returns a non-array payload', async () => {
    mockMergedLinkedPRLookup()
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ message: 'Server Error' })
    })

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({ kind: 'found', pr: { number: 7447, state: 'merged' } })
    expect(outcome.kind === 'found' ? outcome.pr.headDivergedFromMergedPRAtOid : undefined).toBe(
      undefined
    )
  })

  it('leaves linked merged divergence unset without a current head oid', async () => {
    mockMergedLinkedPRLookup()

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null)

    expect(outcome).toMatchObject({ kind: 'found', pr: { number: 7447, state: 'merged' } })
    expect(outcome.kind === 'found' ? outcome.pr.headDivergedFromMergedPRAtOid : undefined).toBe(
      undefined
    )
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })
})
