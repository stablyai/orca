import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})
// Only the provider and the rate-limit probe are faked: the lookup, its exact cache, the retry
// owner and the queue are the real ones.
const provider = vi.hoisted(() => ({ resolve: vi.fn(), gate: vi.fn() }))
vi.mock('./pr-refresh-renderer-port', () => moduleMocks.rendererPortModuleMock(coordinatorMocks))
vi.mock('./pr-refresh-rate-limit-gate', () => ({
  prRefreshRateLimitPausedUntil: provider.gate
}))
vi.mock('../../client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: provider.resolve
}))
vi.mock('../../execution/github-operation-slots', () => ({
  acquire: async () => {},
  release: () => {}
}))

beforeEach(() => {
  moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
  vi.setSystemTime(1_000)
  provider.gate.mockReset().mockResolvedValue(null)
  provider.resolve.mockReset().mockImplementation(async () => found('first'))
})
// Transforming the coordinator's module graph is the slow first step on a loaded machine: do it
// once under the hook limit, so each test still imports its own fresh instance, quickly.
beforeAll(async () => {
  await import('./pr-refresh-coordinator')
})
afterEach(() => {
  // A body that failed must not leave its timers to run on the next test's clock.
  vi.clearAllTimers()
  vi.useRealTimers()
})

function found(title: string): PRRefreshOutcome {
  return {
    kind: 'found',
    fetchedAt: Date.now(),
    pr: makePR({ title, checksStatus: 'pending' })
  }
}

function failed(): PRRefreshOutcome {
  return { kind: 'upstream-error', errorType: 'network', message: 'offline', fetchedAt: Date.now() }
}

const readsOf = (branch: string) =>
  provider.resolve.mock.calls.filter(([read]) => read.branchName === branch).length

/** The title of the last outcome the renderer received for the branch. */
const deliveredTo = (branch: string) =>
  coordinatorMocks.sendToTrustedUIRendererMock.mock.calls
    .map(([, event]) => event)
    .findLast((event) => event.outcome && event.aliases.some((alias) => alias.branch === branch))
    ?.outcome.pr?.title

async function load() {
  const policy = await import('../../../../shared/review-refresh-policy')
  const coordinator = await import('./pr-refresh-coordinator')
  const lookup = await import('../../client/lookup/pr-for-branch-outcome')
  const resources = await import('../../client/lookup/pr-branch-read-resources')
  const { hostedReviewOptionArgs } = await import('./pr-refresh-candidate-policy')
  const switchTo = async (cadence: 'default' | 'reduced' | 'minimal' | 'off', at: number) => {
    await vi.advanceTimersByTimeAsync(at - Date.now())
    policy.setPRAutoRefreshCadence(cadence)
    coordinator.retimePRRefreshesForCadence()
  }
  // 256 other exact results, each held: the exact cache has no room for another.
  const fillExactCache = async () => {
    const holds: (() => void)[] = []
    for (let other = 0; other < 256; other += 1) {
      const prepared = await lookup.preparePRBranchRead(
        '/repo',
        `other-${other}`,
        null,
        null,
        null,
        {
          currentHeadOid: 'head-sha'
        }
      )
      await prepared.read()
      holds.push(prepared.hold())
    }
    return holds
  }
  // A paired client's foreground read of the same request, through the runtime's direct path.
  const directRead = async (candidate: ReturnType<typeof makeCandidate>) => {
    const prepared = await lookup.preparePRBranchRead(
      candidate.repoPath,
      candidate.branch,
      null,
      null,
      null,
      hostedReviewOptionArgs(candidate, 'active')[0] ?? {}
    )
    return coordinator.runHostedPRRead(candidate, prepared)
  }
  const claims = () => resources._prBranchReadResourceCountForTests()
  return { coordinator, lookup, switchTo, fillExactCache, directRead, claims }
}

it('restores a failure the full exact cache could not keep as its own retry, which Off retires again', async () => {
  const { coordinator, switchTo, fillExactCache, claims } = await load()
  const holds = await fillExactCache()
  provider.resolve.mockImplementation(async () => failed())
  const target = makeCandidate({ branch: 'target', currentHeadOid: 'head-sha' })
  // Fails at 1 s with no exact entry; Default would retry it at 121 s.
  coordinator.reportVisiblePRRefreshCandidates([target], 1, 1)
  await vi.advanceTimersByTimeAsync(0)
  expect(readsOf('target')).toBe(1)
  for (const release of holds) {
    release()
  }

  await switchTo('off', 1_500)
  await switchTo('default', 2_000)
  await switchTo('off', 3_000)
  await vi.advanceTimersByTimeAsync(130_000 - Date.now())
  expect(readsOf('target')).toBe(1)

  provider.resolve.mockImplementation(async () => found('recovered'))
  await switchTo('default', Date.now())
  await vi.advanceTimersByTimeAsync(0)
  expect(readsOf('target')).toBe(2)
  expect(coordinatorMocks.sendToTrustedUIRendererMock.mock.calls.at(-1)?.[1]).toMatchObject({
    outcome: { pr: { title: 'recovered' } }
  })
  // Recovery released the failure's claim on its request.
  expect(claims()).toBe(0)
})

it.each(['succeeded', 'failed'] as const)(
  'a cadence turned back on reads once for every shown worktree of a PR whose last read %s',
  async (last) => {
    const { coordinator, switchTo } = await load()
    if (last === 'failed') {
      provider.resolve.mockImplementation(async () => failed())
    }
    const rows = ['a', 'b'].map((branch) =>
      makeCandidate({
        branch,
        worktreeId: `wt-${branch}`,
        cacheKey: `/repo::${branch}`,
        linkedPRNumber: 12,
        currentHeadOid: 'head-sha'
      })
    )
    coordinator.reportVisiblePRRefreshCandidates(rows, 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.resolve).toHaveBeenCalledTimes(1)
    await switchTo('off', 2_000)
    provider.resolve.mockImplementation(async () => found('changed'))
    await switchTo('default', 200_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.resolve).toHaveBeenCalledTimes(2)
    expect([deliveredTo('a'), deliveredTo('b')]).toEqual(['changed', 'changed'])
  }
)

// Off holds no timer, so its row reads again only once Default returns.
async function expectNextAutomaticRead(
  cadence: 'default' | 'off',
  dueAt: number,
  switchTo: (cadence: 'default', at: number) => Promise<void>
) {
  provider.resolve.mockImplementation(async () => found('changed'))
  const due = cadence === 'default' ? dueAt : 700_000
  await vi.advanceTimersByTimeAsync(due - 1 - Date.now())
  expect(readsOf('target')).toBe(2)
  if (cadence === 'off') {
    await switchTo('default', due)
  }
  await vi.advanceTimersByTimeAsync(due - Date.now())
  expect(readsOf('target')).toBe(3)
  expect(deliveredTo('target')).toBe('changed')
}

it.each(['default', 'off'] as const)(
  'a failure a newer read replaced while it ran owes no retry; under %s the row follows that read',
  async (cadence) => {
    const { coordinator, switchTo, fillExactCache, directRead, claims } = await load()
    // The exact cache is full, so neither read below keeps its outcome there.
    await fillExactCache()
    const target = makeCandidate({ branch: 'target', currentHeadOid: 'head-sha' })
    const late = Promise.withResolvers<PRRefreshOutcome>()
    provider.resolve.mockImplementationOnce(() => late.promise)
    coordinator.reportVisiblePRRefreshCandidates([target], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    if (cadence === 'off') {
      await switchTo('off', 1_500)
    }
    // The newer read starts at 5 s and succeeds first; then the old one fails.
    await vi.advanceTimersByTimeAsync(5_000 - Date.now())
    provider.resolve.mockImplementationOnce(async () => found('newer'))
    expect(await directRead(target)).toMatchObject({ pr: { title: 'newer' } })
    late.resolve(failed())
    await vi.advanceTimersByTimeAsync(0)
    expect(claims()).toBe(0)
    // The newer read kept nothing to show, so the old read only ends its loading state; its
    // replaced failure is never published.
    const targetEvents = coordinatorMocks.sendToTrustedUIRendererMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.aliases.some((alias) => alias.branch === 'target'))
    expect(targetEvents.map((event) => event.status ?? event.outcome.kind)).toEqual([
      'in-flight',
      'skipped'
    ])
    // Default: the ordinary follow-up two minutes after the newer read, not the old error's retry.
    await expectNextAutomaticRead(cadence, 125_000, switchTo)
  }
)

it.each(['default', 'off'] as const)(
  'a newer read starting retires a failure already settled, its retry and its claim (%s)',
  async (cadence) => {
    const { coordinator, lookup, switchTo, fillExactCache, directRead, claims } = await load()
    const { hostedReviewOptionArgs } = await import('./pr-refresh-candidate-policy')
    await fillExactCache()
    const target = makeCandidate({ branch: 'target', currentHeadOid: 'head-sha' })
    const running = Promise.withResolvers<PRRefreshOutcome>()
    provider.resolve.mockImplementationOnce(() => running.promise)
    coordinator.reportVisiblePRRefreshCandidates([target], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    // Another reader of the same request joins the running read: it starts nothing, so the failure
    // stays that read's, with its retry at 121 s.
    const joined = lookup.getPRForBranchOutcome(
      '/repo',
      'target',
      null,
      null,
      null,
      hostedReviewOptionArgs(target, 'visible')[0] ?? {}
    )
    await vi.advanceTimersByTimeAsync(0)
    running.resolve(failed())
    expect(await joined).toMatchObject({ kind: 'upstream-error' })
    await vi.advanceTimersByTimeAsync(0)
    expect(readsOf('target')).toBe(1)
    expect(claims()).toBe(1)
    if (cadence === 'off') {
      await switchTo('off', 2_000)
      expect(claims()).toBe(1)
    }
    await vi.advanceTimersByTimeAsync(61_000 - Date.now())
    provider.resolve.mockImplementationOnce(async () => found('newer'))
    await directRead(target)
    expect(claims()).toBe(0)
    await expectNextAutomaticRead(cadence, 181_000, switchTo)
  }
)

it.each(['HEAD', 'scope'] as const)(
  'a parked failure is not restored once the row is another request (%s)',
  async (change) => {
    const { coordinator, switchTo, fillExactCache, claims } = await load()
    const { bumpScopeGeneration, hostedReviewRepoScope } =
      await import('../../../source-control/hosted-review-scope-generations')
    await fillExactCache()
    provider.resolve.mockImplementation(async () => failed())
    const target = makeCandidate({ branch: 'target', currentHeadOid: 'head-sha' })
    coordinator.reportVisiblePRRefreshCandidates([target], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    await switchTo('off', 2_000)
    expect(claims()).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    if (change === 'HEAD') {
      coordinator.reportVisiblePRRefreshCandidates([{ ...target, currentHeadOid: 'head-b' }], 2, 1)
    } else {
      bumpScopeGeneration(hostedReviewRepoScope('/repo', 'local'))
    }
    await switchTo('default', 4_000)
    expect(claims()).toBe(0)

    provider.resolve.mockImplementation(async () => found('changed'))
    await vi.advanceTimersByTimeAsync(121_000 - Date.now())
    expect(readsOf('target')).toBe(2)
    expect(provider.resolve.mock.calls.at(-1)?.[0].options.currentHeadOid).toBe(
      change === 'HEAD' ? 'head-b' : 'head-sha'
    )
    expect(deliveredTo('target')).toBe('changed')
  }
)

it.each(['automatic', 'reported again', 'shown again'] as const)(
  'Off retires a restored follow-up waiting its turn, but not one a return upgraded (%s)',
  async (kind) => {
    const { coordinator, lookup, switchTo } = await load()
    const x = makeCandidate({ branch: 'x', currentHeadOid: 'head-sha' })
    coordinator.reportVisiblePRRefreshCandidates([x], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(readsOf('x')).toBe(1)
    const shownX = {
      ...x,
      cachedFetchedAt: 1_000,
      cachedHeadOid: 'head-sha',
      cachedHasPR: true,
      cachedPRState: 'open' as const,
      cachedChecksStatus: 'pending' as const
    }
    await switchTo('off', 2_000)
    // Other reads push X's exact answer out of the bounded cache while X stays visible.
    for (let other = 0; other < 256; other += 1) {
      await lookup.getPRForBranchOutcome('/repo', `other-${other}`, null, null, null, {
        currentHeadOid: 'head-sha'
      })
    }
    // A newly shown Y reads under Off, and its budgeted start spaces the next one by 10 s.
    await vi.advanceTimersByTimeAsync(199_000 - Date.now())
    const y = makeCandidate({ branch: 'y', worktreeId: 'wt-y', cacheKey: '/repo::y' })
    coordinator.reportVisiblePRRefreshCandidates([shownX, y], 2, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(readsOf('y')).toBe(1)

    await switchTo('default', 200_000)
    if (kind === 'shown again') {
      coordinator.clearVisiblePRRefreshWindow(1)
    }
    if (kind !== 'automatic') {
      // A routine report keeps the restored follow-up automatic; only a return earns a read.
      coordinator.reportVisiblePRRefreshCandidates([shownX, y], 3, 1)
    }
    await switchTo('off', 201_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(readsOf('x')).toBe(kind === 'shown again' ? 2 : 1)

    provider.resolve.mockImplementation(async () => found('changed'))
    await switchTo('default', Date.now())
    await vi.advanceTimersByTimeAsync(15_000)
    // The automatic one is restored and reads now; the shown-again one already read under Off.
    expect(readsOf('x')).toBe(2)
    expect(deliveredTo('x')).toBe(kind === 'shown again' ? 'first' : 'changed')
  }
)

it.each(['off', 'reduced'] as const)(
  'a restored follow-up that waited for quota starts only when %s still gives it',
  async (cadence) => {
    const { coordinator, lookup, switchTo } = await load()
    const x = makeCandidate({ branch: 'x', currentHeadOid: 'head-sha' })
    coordinator.reportVisiblePRRefreshCandidates([x], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    await switchTo('off', 2_000)
    // Other reads push X's exact answer out of the bounded cache, so none can stand in for a start.
    for (let other = 0; other < 256; other += 1) {
      await lookup.getPRForBranchOutcome('/repo', `other-${other}`, null, null, null, {
        currentHeadOid: 'head-sha'
      })
    }
    await vi.advanceTimersByTimeAsync(200_000 - Date.now())
    const quota = Promise.withResolvers<number | null>()
    provider.gate.mockReturnValueOnce(quota.promise)
    await switchTo('default', 200_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.gate).toHaveBeenCalled()
    await switchTo(cadence, 201_000)
    provider.resolve.mockImplementation(async () => found('changed'))
    if (cadence === 'off') {
      quota.resolve(null)
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(readsOf('x')).toBe(1)
      return
    }
    // Reduced puts X's next read five intervals after its data (1 s + 600 s); a shorter learned
    // pause does not bring it forward.
    await vi.advanceTimersByTimeAsync(1_000)
    quota.resolve(300_000)
    await vi.advanceTimersByTimeAsync(600_999 - Date.now())
    expect(readsOf('x')).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(readsOf('x')).toBe(2)
    expect(deliveredTo('x')).toBe('changed')
  }
)

/** Opens these renderer windows; a closed one reports destroyed before any cleanup for it runs. */
function openWindows(...ids: number[]): (id: number) => void {
  const closed = new Set<number>()
  coordinatorMocks.getAllWebContentsMock.mockReturnValue(
    ids.map((id) => ({ id, isDestroyed: () => closed.has(id) }))
  )
  return (id) => closed.add(id)
}

const row = (branch: string) =>
  makeCandidate({ branch, worktreeId: `wt-${branch}`, cacheKey: `/repo::${branch}` })

it('a parked failure releases its claim once no window shows its row, however that demand ends', async () => {
  const { coordinator, switchTo, claims } = await load()
  const close = openWindows(1, 2, 3)
  provider.resolve.mockImplementation(async () => failed())
  coordinator.reportVisiblePRRefreshCandidates([row('a'), row('shared'), row('removed')], 1, 1)
  coordinator.reportVisiblePRRefreshCandidates([row('shared')], 1, 2)
  await vi.advanceTimersByTimeAsync(30_000)
  expect([readsOf('a'), readsOf('shared'), readsOf('removed')]).toEqual([1, 1, 1])
  // Off leaves no queued work; each failure keeps its claim while its row is shown.
  await switchTo('off', 31_000)
  expect(coordinator._getPRRefreshQueueSizeForTests()).toBe(0)
  expect(claims()).toBe(3)

  // A removed workspace's row has no queued alias to prune, yet its demand ends.
  coordinator.pruneWorktreePRRefreshAliases('wt-removed')
  expect(claims()).toBe(2)
  // Window 1 is already destroyed when its close cleanup runs; window 2 still shows the shared row.
  close(1)
  coordinator.clearVisiblePRRefreshWindow(1)
  expect(claims()).toBe(1)
  // Window 2 closes with no cleanup of its own; the next report, from window 3, prunes it.
  close(2)
  coordinator.reportVisiblePRRefreshCandidates([], 1, 3)
  expect(claims()).toBe(0)
  expect(coordinator._getPRRefreshErrorBackoffCountForTests()).toBe(0)
})

it.each([750, 7_500])(
  'a report from another window does no bookkeeping over %i unchanged rows, and its dropped row releases',
  async (count) => {
    const { coordinator, claims } = await load()
    const { PRRefreshVisibility } = await import('./pr-refresh-visibility')
    const { PRRefreshRetryState } = await import('./pr-refresh-retry-state')
    openWindows(1, 2)
    provider.resolve.mockImplementation(async () => failed())
    coordinator.reportVisiblePRRefreshCandidates([row('b')], 1, 2)
    await vi.advanceTimersByTimeAsync(0)
    expect(claims()).toBe(1)
    coordinator.reportVisiblePRRefreshCandidates(
      Array.from({ length: count }, (_, index) => row(`a-${index}`)),
      1,
      1
    )
    const memberships = vi.spyOn(PRRefreshVisibility.prototype, 'has')
    const releases = vi.spyOn(PRRefreshRetryState.prototype, 'releaseFailure')
    const rendererChecks = coordinatorMocks.webContentsFromIdMock
    const work = (report: () => void) => {
      for (const counter of [memberships, releases, rendererChecks]) {
        counter.mockClear()
      }
      report()
      return [memberships, releases, rendererChecks].map((counter) => counter.mock.calls.length)
    }
    // Row membership checks, failure releases and renderer checks: one prune of the two windows per
    // report, and only B's dropped row is checked and released.
    expect(work(() => coordinator.reportVisiblePRRefreshCandidates([row('b')], 2, 2))).toEqual([
      0, 0, 2
    ])
    expect(work(() => coordinator.reportVisiblePRRefreshCandidates([], 1, 2))).toEqual([0, 0, 2])
    expect(work(() => coordinator.reportVisiblePRRefreshCandidates([], 3, 2))).toEqual([1, 1, 2])
    expect(claims()).toBe(0)
    expect(coordinator._getPRRefreshErrorBackoffCountForTests()).toBe(0)
  }
)

it('a drain that finds every queued row’s window closed ends quietly; a row still shown reads on', async () => {
  const { coordinator, claims } = await load()
  const close = openWindows(1, 2)
  coordinator.reportVisiblePRRefreshCandidates([row('a')], 1, 1)
  coordinator.reportVisiblePRRefreshCandidates([row('b')], 1, 2)
  await vi.advanceTimersByTimeAsync(20_000)
  expect([readsOf('a'), readsOf('b')]).toEqual([1, 1])
  provider.resolve.mockImplementation(async () => found('changed'))
  // Window 1 closes with no cleanup call: its follow-up at 121 s finds it gone when the drain runs.
  close(1)
  await vi.advanceTimersByTimeAsync(131_000 - Date.now())
  expect([readsOf('a'), readsOf('b')]).toEqual([1, 2])
  expect(deliveredTo('b')).toBe('changed')
  // The last window closes too: its row's next follow-up is the only queued work, and goes.
  close(2)
  await vi.advanceTimersByTimeAsync(251_000 - Date.now())
  expect([readsOf('a'), readsOf('b')]).toEqual([1, 2])
  expect(coordinator._getPRRefreshQueueSizeForTests()).toBe(0)
  expect(coordinator._getVisiblePRRefreshWindowCountForTests()).toBe(0)
  expect(claims()).toBe(0)
})

it.each(['a routine report', 'another HEAD'] as const)(
  'an action that waited for quota keeps its turn when %s queues the row again meanwhile',
  async (change) => {
    const { coordinator } = await load()
    const x = makeCandidate({ branch: 'x', isSelected: true, currentHeadOid: 'head-sha' })
    coordinator.reportVisiblePRRefreshCandidates([x], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    const shownX = {
      ...x,
      cachedFetchedAt: 1_000,
      cachedHeadOid: 'head-sha',
      cachedHasPR: true,
      cachedPRState: 'open' as const,
      cachedChecksStatus: 'pending' as const
    }
    // At 2 s the user's action reads X; quota is still being checked when the row is reported.
    await vi.advanceTimersByTimeAsync(1_000)
    const quota = Promise.withResolvers<number | null>()
    provider.gate.mockReturnValueOnce(quota.promise)
    coordinator.enqueuePRRefresh(shownX, 'active', 80, 1)
    await vi.advanceTimersByTimeAsync(0)
    const head = change === 'another HEAD' ? 'head-b' : 'head-sha'
    coordinator.reportVisiblePRRefreshCandidates([{ ...shownX, currentHeadOid: head }], 2, 1)
    // Quota answers with a pause until 22 s.
    await vi.advanceTimersByTimeAsync(1_000)
    quota.resolve(22_000)
    provider.resolve.mockImplementation(async () => found('changed'))
    await vi.advanceTimersByTimeAsync(21_999 - Date.now())
    expect(readsOf('x')).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(readsOf('x')).toBe(2)
    // Another HEAD queued since is a newer request; the old captured one does not replace it.
    expect(provider.resolve.mock.calls.at(-1)?.[0].options.currentHeadOid).toBe(head)
    expect(deliveredTo('x')).toBe('changed')
  }
)

it('an action that waited for quota keeps its turn when another worktree of its PR is reported meanwhile', async () => {
  const { coordinator } = await load()
  const [firstWindow] = coordinatorMocks.getAllWebContentsMock()
  coordinatorMocks.getAllWebContentsMock.mockReturnValue([firstWindow, { ...firstWindow, id: 2 }])
  const row = (branch: string) =>
    makeCandidate({
      branch,
      worktreeId: `wt-${branch}`,
      cacheKey: `/repo::${branch}`,
      linkedPRNumber: 12,
      currentHeadOid: 'head-sha'
    })
  const x = row('x')
  coordinator.reportVisiblePRRefreshCandidates([x], 1, 1)
  await vi.advanceTimersByTimeAsync(0)
  const shownX = {
    ...x,
    cachedFetchedAt: 1_000,
    cachedHeadOid: 'head-sha',
    cachedHasPR: true,
    cachedPRState: 'open' as const,
    cachedChecksStatus: 'pending' as const
  }
  // X is pushed at 2 s; its read is due after the push delay, at 4.5 s, and waits for quota.
  await vi.advanceTimersByTimeAsync(1_000)
  const quota = Promise.withResolvers<number | null>()
  let waitingForQuota = false
  provider.gate.mockImplementationOnce(() => {
    waitingForQuota = true
    return quota.promise
  })
  coordinator.enqueuePRRefresh(shownX, 'post-push', 80, 1)
  await vi.advanceTimersByTimeAsync(4_500 - Date.now())
  expect(waitingForQuota).toBe(true)
  // Meanwhile a second window first shows worktree Y on the same PR, which queues its own read;
  // X stays shown in the first window.
  coordinator.reportVisiblePRRefreshCandidates([row('y')], 1, 2)
  // Y's own entry is the only queued work while X is out of the queue waiting.
  expect(coordinator._getPRRefreshQueueSizeForTests()).toBe(1)
  await vi.advanceTimersByTimeAsync(1_000)
  quota.resolve(22_000)
  provider.resolve.mockImplementation(async () => found('pushed'))
  await vi.advanceTimersByTimeAsync(21_999 - Date.now())
  expect(provider.resolve).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  // The push's own read goes, and Y, coalesced with it, gets that answer too.
  expect(provider.resolve.mock.calls.map(([read]) => read.branchName)).toEqual(['x', 'x'])
  expect([deliveredTo('x'), deliveredTo('y')]).toEqual(['pushed', 'pushed'])
})

it.each(['its read', 'its failure', 'an earlier head’s read'] as const)(
  'a queued watch planned from %s follows a cadence change from that same anchor',
  async (anchor) => {
    const { coordinator, switchTo } = await load()
    const headReads = vi.fn(async () => Date.now())
    coordinator.setPRWatchJobHooks({ isWatched: () => true, readHeadChecks: headReads })
    if (anchor === 'its failure') {
      provider.resolve.mockImplementation(async () => failed())
    }
    const watched = makeCandidate({ branch: 'watched', linkedPRNumber: 12 })
    const job =
      anchor === 'an earlier head’s read'
        ? { prKey: 'github.com/acme/repo#12', headSha: 'old-head' }
        : { prKey: 'github.com/acme/repo#12' }
    const watchReads = () =>
      anchor === 'an earlier head’s read' ? headReads.mock.calls.length : readsOf('watched')
    await switchTo('minimal', 1_000)
    coordinator.schedulePRWatchRead(job, watched, 1_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(watchReads()).toBe(1)
    // Minimal put the next read at 1 201 s; Default, set at 2 s, puts it at 121 s from the same read.
    await switchTo('default', 2_000)
    await vi.advanceTimersByTimeAsync(120_999 - Date.now())
    expect(watchReads()).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(watchReads()).toBe(2)
  }
)

it('a watch that waited for quota while Off slowed it to Minimal reads at the Minimal time', async () => {
  const { coordinator, switchTo } = await load()
  coordinator.setPRWatchJobHooks({ isWatched: () => true, readHeadChecks: async () => null })
  const watched = makeCandidate({ branch: 'watched', linkedPRNumber: 12 })
  coordinator.schedulePRWatchRead({ prKey: 'github.com/acme/repo#12' }, watched, 1_000)
  await vi.advanceTimersByTimeAsync(0)
  // Due at 121 s on Default; quota is still being checked when Off (Minimal for watches) arrives.
  await vi.advanceTimersByTimeAsync(121_000 - Date.now() - 1)
  const quota = Promise.withResolvers<number | null>()
  provider.gate.mockReturnValueOnce(quota.promise)
  await vi.advanceTimersByTimeAsync(1)
  expect(provider.gate).toHaveBeenLastCalledWith(watched, true)
  await switchTo('off', 121_500)
  quota.resolve(null)
  await vi.advanceTimersByTimeAsync(1_200_999 - Date.now())
  expect(readsOf('watched')).toBe(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(readsOf('watched')).toBe(2)
})

it('retiming an old HEAD failure cannot delay the newer HEAD return under Off', async () => {
  const { coordinator, switchTo } = await load()
  const target = makeCandidate({ branch: 'target', linkedPRNumber: 7, currentHeadOid: 'head-a' })
  const older = Promise.withResolvers<PRRefreshOutcome>()
  const newer = Promise.withResolvers<PRRefreshOutcome>()
  const observed: PRRefreshOutcome[] = []
  coordinator.addPRRefreshOutcomeObserver((_, outcome) => observed.push(outcome))
  provider.resolve.mockImplementationOnce(() => older.promise)
  coordinator.reportVisiblePRRefreshCandidates([target], 1, 1)
  await vi.advanceTimersByTimeAsync(0)

  await vi.advanceTimersByTimeAsync(1_000)
  const current = { ...target, currentHeadOid: 'head-b' }
  coordinator.reportVisiblePRRefreshCandidates([current], 2, 1)
  provider.resolve.mockImplementationOnce(() => newer.promise)
  const manual = coordinator.refreshPRNow(current, 'manual')
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(1_000)
  older.resolve(failed())
  await vi.advanceTimersByTimeAsync(0)
  const errorsBeforeRetime = observed.filter((outcome) => outcome.kind === 'upstream-error').length
  expect(errorsBeforeRetime).toBe(1)
  await switchTo('off', 3_500)
  await vi.advanceTimersByTimeAsync(500)
  newer.resolve({
    kind: 'found',
    fetchedAt: 4_000,
    pr: makePR({
      number: 7,
      title: 'newer',
      headSha: 'head-b',
      state: 'merged',
      checksStatus: 'success'
    })
  })
  expect(await manual).toMatchObject({ fetchedAt: 4_000, pr: { title: 'newer' } })
  expect(deliveredTo('target')).toBe('newer')
  coordinator.clearVisiblePRRefreshWindow(1)
  await vi.advanceTimersByTimeAsync(65_000 - Date.now())
  provider.resolve.mockImplementationOnce(async () => ({
    kind: 'found',
    fetchedAt: Date.now(),
    pr: makePR({
      number: 7,
      title: 'returned',
      headSha: 'head-b',
      state: 'merged',
      checksStatus: 'success'
    })
  }))
  coordinator.reportVisiblePRRefreshCandidates(
    [
      {
        ...current,
        cachedFetchedAt: 4_000,
        cachedHeadOid: 'head-b',
        cachedHasPR: true,
        cachedPRState: 'merged',
        cachedChecksStatus: 'success'
      }
    ],
    3,
    1
  )
  await vi.advanceTimersByTimeAsync(0)
  expect(deliveredTo('target')).toBe('returned')
  const delivered = coordinatorMocks.sendToTrustedUIRendererMock.mock.calls
    .map(([, event]) => event)
    .findLast((event) => event.outcome?.pr?.title === 'returned')
  expect(delivered?.outcome.fetchedAt).toBe(65_000)
  expect(observed.filter((outcome) => outcome.kind === 'upstream-error')).toHaveLength(
    errorsBeforeRetime
  )
})
