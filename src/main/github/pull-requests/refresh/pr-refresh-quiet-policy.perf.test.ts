import { afterEach, expect, it, vi } from 'vitest'
import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

vi.mock('../../client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: async () => ({
    kind: 'found',
    fetchedAt: Date.now(),
    pr: makePR({
      headSha: 'head',
      checksStatus: 'success',
      checksReadComplete: true,
      checksFinal: true,
      autoMergeEnabled: false,
      mergeQueueRequired: false
    })
  })
}))
vi.mock('../../execution/github-operation-slots', () => ({
  acquire: async () => {},
  release: () => {}
}))

let release: (() => void) | undefined
afterEach(() => {
  release?.()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

it.each([750, 7500])(
  'selects owned quiet policy without inventory discovery at %i workspaces',
  async (population) => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const accounts = await import('../../accounts/github-project-account')
    const execution = await import('../../../source-control/code-host-read-execution-scope')
    const repository = {
      id: 'repo',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: 'blue',
      addedAt: 0,
      ghAccount: { host: 'github.com', user: 'first' }
    }
    const inventory = vi.fn(() =>
      Array.from({ length: population }, (_, row) => ({ repoId: 'repo', path: `/repo/wt-${row}` }))
    )
    const metadata = vi.fn(() => ({}))
    release = accounts.installGitHubProjectAccounts(
      { getRepos: () => [repository], getAllWorktreeMetaForHost: metadata },
      inventory
    )
    const discovery = vi.spyOn(accounts, 'resolveGitHubProjectAccount')
    const hashing = vi.spyOn(execution, 'codeHostReadExecutionScope')
    const { getPRForBranchOutcome } = await import('../../client/lookup/pr-for-branch-outcome')
    const { runHostedPRRead, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    const { refreshIntervalForCandidate } = await import('./pr-refresh-candidate-policy')
    const { refreshPRPolicyContext } = await import('../../client/lookup/pr-quiet-policy-evidence')
    const candidate = makeCandidate({
      repoId: 'repo',
      repoPath: '/repo/wt-0',
      branch: 'branch',
      currentHeadOid: 'head',
      cachedHeadOid: 'head',
      cachedFetchedAt: 2_000,
      cachedPRState: 'open',
      cachedChecksStatus: 'success',
      cachedHasPR: true
    })
    const read = () =>
      runHostedPRRead(candidate, () =>
        getPRForBranchOutcome('/repo/wt-0', 'branch', null, null, null, { currentHeadOid: 'head' })
      )
    await read()
    vi.setSystemTime(2_000)
    await read()
    expect(refreshIntervalForCandidate(candidate)).toBe(300_000)
    discovery.mockClear()
    hashing.mockClear()
    inventory.mockClear()
    metadata.mockClear()
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    for (let row = 0; row < population; row++) {
      refreshIntervalForCandidate(candidate)
    }
    expect(discovery).not.toHaveBeenCalled()
    expect(hashing).not.toHaveBeenCalled()
    expect(inventory).not.toHaveBeenCalled()
    expect(metadata).not.toHaveBeenCalled()
    expect(refreshIntervalForCandidate({ ...candidate, fallbackPRNumber: 9 })).toBe(120_000)
    const { bumpScopeGeneration, hostedReviewRepoScope } =
      await import('../../../source-control/hosted-review-scope-generations')
    bumpScopeGeneration(hostedReviewRepoScope(candidate.repoPath, 'local'))
    expect(refreshIntervalForCandidate(candidate)).toBe(120_000)
    vi.setSystemTime(3_000)
    await read()
    vi.setSystemTime(4_000)
    await read()
    expect(refreshIntervalForCandidate({ ...candidate, cachedFetchedAt: 4_000 })).toBe(300_000)
    repository.ghAccount = { host: 'github.com', user: 'second' }
    refreshPRPolicyContext()
    expect(refreshIntervalForCandidate({ ...candidate, cachedFetchedAt: 4_000 })).toBe(120_000)
    vi.setSystemTime(5_000)
    await read()
    vi.setSystemTime(6_000)
    await read()
    expect(refreshIntervalForCandidate({ ...candidate, cachedFetchedAt: 6_000 })).toBe(300_000)
  }
)
