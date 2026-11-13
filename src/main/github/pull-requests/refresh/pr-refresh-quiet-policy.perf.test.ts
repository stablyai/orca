import { afterEach, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

// The provider records what each actual read asked; the quota probe can be held. Windows 1-8 are
// open renderers.
const fixture = vi.hoisted(() => ({
  reads: [] as { repoPath: string; ghOptions: { ghAccount?: { user?: string } } }[],
  gate: vi.fn(async (): Promise<number | null> => null),
  onRead: null as null | (() => void)
}))
vi.mock('../../client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: async (read: (typeof fixture.reads)[number]) => {
    fixture.reads.push(read)
    fixture.onRead?.()
    return {
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
    } satisfies PRRefreshOutcome
  }
}))
vi.mock('./pr-refresh-rate-limit-gate', () => ({
  prRefreshRateLimitPausedUntil: fixture.gate
}))
vi.mock('./pr-refresh-renderer-port', () => ({
  prRefreshRenderers: () => ({
    isRendererOpen: (id: number) => id >= 1 && id <= 8,
    sendToTrustedUI: () => {}
  })
}))
vi.mock('../../execution/github-operation-slots', () => ({
  acquire: async () => {},
  release: () => {}
}))

let release: (() => void) | undefined
afterEach(() => {
  release?.()
  fixture.reads.length = 0
  fixture.onRead = null
  fixture.gate.mockReset().mockImplementation(async () => null)
  vi.clearAllTimers()
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

// A visible row at worktree /repo/wt-0 (not the repository root), so each account discovery walks
// the whole installed worktree inventory.
async function installFleet(population: number) {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  const accounts = await import('../../accounts/github-project-account')
  const repository = {
    id: 'repo',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: 'blue',
    addedAt: 0,
    ghAccount: { host: 'github.com', user: 'first' }
  }
  const rows = Array.from({ length: population }, (_, row) => ({
    repoId: 'repo',
    path: `/repo/wt-${row}`
  }))
  let visits = 0
  const inventory = vi.fn(
    () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the resolver only iterates the inventory; the iterable counts each worktree it visits.
      ({
        *[Symbol.iterator]() {
          for (const row of rows) {
            visits += 1
            yield row
          }
        }
      }) as unknown as readonly { repoId: string; path: string }[]
  )
  const metadata = vi.fn(() => ({}))
  release = accounts.installGitHubProjectAccounts(
    { getRepos: () => [repository], getAllWorktreeMetaForHost: metadata },
    inventory
  )
  const discovery = vi.spyOn(accounts, 'resolveGitHubProjectAccount')
  const work = () => ({
    discoveries: discovery.mock.calls.length,
    inventories: inventory.mock.calls.length,
    metadata: metadata.mock.calls.length,
    visits
  })
  return { repository, work }
}

it.each([
  [750, 1],
  [750, 4],
  [7_500, 1],
  [7_500, 4]
])(
  'admits a visible row at %i workspaces with one scope per demand decision, %i window(s) showing it',
  async (population, windows) => {
    const { work } = await installFleet(population)
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    const row = makeCandidate({ repoId: 'repo', repoPath: '/repo/wt-0', branch: 'branch' })
    // Earlier windows show the same key with another HEAD (another request), so each decision
    // compares them before it reaches the window that shows this one.
    for (let window = 1; window < windows; window += 1) {
      reportVisiblePRRefreshCandidates([], 1, window)
    }
    const quota = Promise.withResolvers<number | null>()
    fixture.gate.mockReturnValueOnce(quota.promise)
    reportVisiblePRRefreshCandidates([row], 1, windows)
    for (let window = 1; window < windows; window += 1) {
      reportVisiblePRRefreshCandidates(
        [
          {
            ...row,
            worktreeId: `wt-other-${window}`,
            cacheKey: `other-${window}`,
            currentHeadOid: 'old'
          }
        ],
        2,
        window
      )
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.gate).toHaveBeenCalledTimes(1)
    expect(fixture.reads).toEqual([])
    // From quota to the provider start: the decision after quota, preparation, its own scope
    // check, and the decision after preparation.
    const atQuota = work()
    const marks: { atStart?: ReturnType<typeof work> } = {}
    fixture.onRead = () => {
      marks.atStart ??= work()
    }
    quota.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.reads).toHaveLength(1)
    const spent = {
      discoveries: marks.atStart!.discoveries - atQuota.discoveries,
      inventories: marks.atStart!.inventories - atQuota.inventories,
      metadata: marks.atStart!.metadata - atQuota.metadata,
      visits: marks.atStart!.visits - atQuota.visits
    }
    // One scope for each of the two demand decisions, plus preparation's own scope and its
    // independent current-scope check; none for any compared window, at either fleet size.
    expect(spent.discoveries).toBe(4)
    expect(spent.inventories).toBe(4)
    expect(spent.metadata).toBe(4)
    expect(spent.visits).toBe(4 * population)
  }
)

it('reads with the account installed when it starts, after the account changed while it waited', async () => {
  const { repository } = await installFleet(750)
  const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
  const row = makeCandidate({ repoId: 'repo', repoPath: '/repo/wt-0', branch: 'branch' })
  const quota = Promise.withResolvers<number | null>()
  fixture.gate.mockReturnValueOnce(quota.promise)
  reportVisiblePRRefreshCandidates([row], 1, 1)
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.gate).toHaveBeenCalledTimes(1)
  // The project's account changes while the read waits for quota.
  repository.ghAccount = { host: 'github.com', user: 'second' }
  quota.resolve(null)
  await vi.advanceTimersByTimeAsync(0)
  expect(fixture.reads).toHaveLength(1)
  expect(fixture.reads[0]?.ghOptions.ghAccount?.user).toBe('second')
})
