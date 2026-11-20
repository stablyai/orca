import { afterEach, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const fixture = vi.hoisted(() => ({
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the empty fixture log is populated only with this provider request shape.
  reads: [] as { repoPath: string; ghOptions: { ghAccount?: { user?: string } } }[],
  failure: false,
  gate: vi.fn(async (): Promise<number | null> => null),
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture starts without a callback and installs a no-argument read hook.
  onRead: null as null | (() => void)
}))
vi.mock('../../client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: async (read: (typeof fixture.reads)[number]) => {
    fixture.reads.push(read)
    fixture.onRead?.()
    if (fixture.failure) {
      return {
        kind: 'upstream-error',
        errorType: 'network',
        message: 'offline',
        fetchedAt: Date.now()
      } satisfies PRRefreshOutcome
    }
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
  fixture.failure = false
  fixture.gate.mockReset().mockImplementation(async () => null)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

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
  const inventory = () => rows
  release = accounts.installGitHubProjectAccounts(
    { getRepos: () => [repository], getAllWorktreeMetaForHost: () => ({}) },
    inventory
  )
  return { repository }
}

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

it.each(['bound', 'unbound'] as const)(
  'an explicitly bound paired read backs off the visible row of a known %s project',
  async (binding) => {
    const { repository } = await installFleet(750)
    if (binding === 'unbound') {
      Reflect.deleteProperty(repository, 'ghAccount')
    }
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    const { getPRForBranchOutcome } = await import('../../client/lookup/pr-for-branch-outcome')
    const row = makeCandidate({
      repoId: 'repo',
      repoPath: '/repo/wt-0',
      branch: 'target',
      currentHeadOid: 'head'
    })
    reportVisiblePRRefreshCandidates([row], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(fixture.reads).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(119_000 - Date.now())
    fixture.failure = true
    const outcome = await getPRForBranchOutcome('/repo/wt-0', 'target', null, null, null, {
      currentHeadOid: 'head',
      localGitExecOptions: { ghAccount: { host: 'github.com', user: 'first' } },
      userRefresh: true
    })
    expect(outcome).toMatchObject({ kind: 'upstream-error', nextAutoRetryAt: 239_000 })
    const atFailure = fixture.reads.length
    await vi.advanceTimersByTimeAsync(238_999 - Date.now())
    expect(fixture.reads).toHaveLength(atFailure)
    await vi.advanceTimersByTimeAsync(1)
    expect(fixture.reads).toHaveLength(atFailure + 1)
  }
)

it.each(['unknown', 'removed'] as const)(
  'an explicit account failure does not back off default-account demand when its project is %s',
  async (ownership) => {
    await installFleet(750)
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    const { getPRForBranchOutcome } = await import('../../client/lookup/pr-for-branch-outcome')
    const row = makeCandidate({
      repoId: 'repo',
      repoPath: '/repo/wt-0',
      branch: 'target',
      currentHeadOid: 'head'
    })
    reportVisiblePRRefreshCandidates([row], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(119_000 - Date.now())
    fixture.failure = true
    if (ownership === 'unknown') {
      release?.()
    } else {
      // Ownership changes during the read; the explicit fallback keeps the same account.
      fixture.onRead = () => release?.()
    }
    const outcome = await getPRForBranchOutcome('/repo/wt-0', 'target', null, null, null, {
      currentHeadOid: 'head',
      localGitExecOptions: { ghAccount: { host: 'github.com', user: 'first' } },
      userRefresh: true
    })
    expect(outcome).not.toHaveProperty('nextAutoRetryAt')
    const atFailure = fixture.reads.length
    await vi.advanceTimersByTimeAsync(121_000 - Date.now())
    expect(fixture.reads).toHaveLength(atFailure + 1)
    expect(fixture.reads.at(-1)?.ghOptions.ghAccount).toBeUndefined()
  }
)
