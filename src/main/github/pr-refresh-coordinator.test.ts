import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPRRefreshCandidate, PRInfo } from '../../shared/types'

const { sendMock, getAllWebContentsMock, getPRForBranchOutcomeMock, getRateLimitMock } = vi.hoisted(
  () => ({
    sendMock: vi.fn(),
    getAllWebContentsMock: vi.fn(),
    getPRForBranchOutcomeMock: vi.fn(),
    getRateLimitMock: vi.fn()
  })
)

vi.mock('electron', () => ({
  webContents: {
    getAllWebContents: getAllWebContentsMock
  }
}))

vi.mock('./client', () => ({
  getPRForBranchOutcome: getPRForBranchOutcomeMock
}))

vi.mock('./rate-limit', () => ({
  getRateLimit: getRateLimitMock,
  noteRateLimitSpend: vi.fn(),
  rateLimitGuard: vi.fn(() => ({ blocked: false }))
}))

function makeCandidate(
  overrides: Partial<GitHubPRRefreshCandidate> = {}
): GitHubPRRefreshCandidate {
  return {
    cacheKey: '/repo::feature/test',
    repoPath: '/repo',
    branch: 'feature/test',
    repoKind: 'git',
    repoId: 'repo-1',
    worktreeId: 'wt-1',
    cachedFetchedAt: null,
    ...overrides
  }
}

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 12,
    title: 'Test PR',
    state: 'open',
    url: 'https://github.com/acme/repo/pull/12',
    checksStatus: 'pending',
    updatedAt: '2026-05-12T00:00:00Z',
    mergeable: 'UNKNOWN',
    headSha: 'head-sha',
    ...overrides
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('pr-refresh-coordinator', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    sendMock.mockReset()
    getAllWebContentsMock.mockReset()
    getPRForBranchOutcomeMock.mockReset()
    getRateLimitMock.mockReset()
    getAllWebContentsMock.mockReturnValue([
      {
        id: 1,
        isDestroyed: () => false,
        send: sendMock
      }
    ])
    getRateLimitMock.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not show visible background refreshes as queued', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ checksStatus: 'pending' }),
      fetchedAt: Date.now()
    })

    reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.runOnlyPendingTimersAsync()

    const queuedEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.status === 'queued')

    expect(queuedEvents).toHaveLength(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('lets an active worktree refresh bypass a delayed visible follow-up', async () => {
    const { enqueuePRRefresh, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'pending' }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success' }),
        fetchedAt: Date.now()
      })

    const candidate = makeCandidate()
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.runOnlyPendingTimersAsync()
    enqueuePRRefresh({ ...candidate, cachedFetchedAt: Date.now() }, 'active', 80, 1)
    await vi.runOnlyPendingTimersAsync()

    const inFlightEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.status === 'in-flight')

    expect(inFlightEvents.map((event) => event.reason)).toEqual(['visible', 'active'])
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('lets a repeated active refresh pull forward an equal-priority visible follow-up', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success' }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success', state: 'merged' }),
        fetchedAt: Date.now()
      })

    const candidate = makeCandidate()
    enqueuePRRefresh(candidate, 'active', 80, 1)
    await vi.runOnlyPendingTimersAsync()

    enqueuePRRefresh(
      {
        ...candidate,
        cachedFetchedAt: Date.now(),
        cachedChecksStatus: 'success'
      },
      'active',
      80,
      1
    )
    await vi.runOnlyPendingTimersAsync()

    const inFlightEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.status === 'in-flight')
    const queuedEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.status === 'queued')

    expect(inFlightEvents.map((event) => event.reason)).toEqual(['active', 'active'])
    expect(queuedEvents).toHaveLength(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('preserves an active refresh queued while a visible refresh is in flight', async () => {
    const { enqueuePRRefresh, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    const visibleOutcome = deferred<{
      kind: 'found'
      pr: PRInfo
      fetchedAt: number
    }>()
    getPRForBranchOutcomeMock.mockReturnValueOnce(visibleOutcome.promise).mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ checksStatus: 'success', state: 'merged' }),
      fetchedAt: Date.now()
    })

    const candidate = makeCandidate()
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)

    enqueuePRRefresh({ ...candidate, cachedFetchedAt: Date.now() }, 'active', 80, 1)
    visibleOutcome.resolve({
      kind: 'found',
      pr: makePR({ checksStatus: 'pending' }),
      fetchedAt: Date.now()
    })
    await vi.advanceTimersByTimeAsync(0)

    const inFlightEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.status === 'in-flight')

    expect(inFlightEvents.map((event) => event.reason)).toEqual(['visible', 'active'])
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('cancels queued work when a later enqueue marks the candidate invalid', async () => {
    const { enqueuePRRefresh, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ checksStatus: 'success' }),
      fetchedAt: Date.now()
    })

    const candidate = makeCandidate()
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)

    enqueuePRRefresh(
      { ...candidate, isArchived: true, cachedFetchedAt: Date.now() },
      'active',
      80,
      1
    )
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    const skippedEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.status === 'skipped')

    expect(skippedEvents.at(-1)?.skippedReason).toBe('archived')
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('does not cancel other aliases when one coalesced PR alias becomes invalid', async () => {
    const { enqueuePRRefresh, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success' }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success', state: 'merged' }),
        fetchedAt: Date.now()
      })

    const first = makeCandidate({
      cacheKey: '/repo::feature/a',
      branch: 'feature/a',
      linkedPRNumber: 12,
      worktreeId: 'wt-a'
    })
    const second = makeCandidate({
      cacheKey: '/repo::feature/b',
      branch: 'feature/b',
      linkedPRNumber: 12,
      worktreeId: 'wt-b'
    })
    reportVisiblePRRefreshCandidates([first, second], 1, 1)
    await vi.advanceTimersByTimeAsync(0)

    enqueuePRRefresh({ ...first, isArchived: true, cachedFetchedAt: Date.now() }, 'active', 80, 1)
    enqueuePRRefresh({ ...second, cachedFetchedAt: Date.now() }, 'active', 80, 1)
    await vi.advanceTimersByTimeAsync(0)

    const outcomeEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.outcome)

    expect(outcomeEvents.at(-1)?.aliases.map((alias) => alias.cacheKey)).toEqual([
      '/repo::feature/b'
    ])
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('preserves coalesced aliases across visible follow-up refreshes', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'pending' }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success' }),
        fetchedAt: Date.now()
      })

    reportVisiblePRRefreshCandidates(
      [
        makeCandidate({
          cacheKey: '/repo::feature/a',
          branch: 'feature/a',
          linkedPRNumber: 12,
          worktreeId: 'wt-a'
        }),
        makeCandidate({
          cacheKey: '/repo::feature/b',
          branch: 'feature/b',
          linkedPRNumber: 12,
          worktreeId: 'wt-b'
        })
      ],
      1,
      1
    )
    await vi.runOnlyPendingTimersAsync()
    await vi.advanceTimersByTimeAsync(90_000)

    const outcomeEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.outcome)

    expect(outcomeEvents).toHaveLength(2)
    expect(outcomeEvents[1].aliases.map((alias) => alias.cacheKey).sort()).toEqual([
      '/repo::feature/a',
      '/repo::feature/b'
    ])
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })
})
