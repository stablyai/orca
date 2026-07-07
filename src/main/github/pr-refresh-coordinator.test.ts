/* eslint-disable max-lines -- Why: coordinator tests cover queueing, coalescing,
request timestamps, and follow-up scheduling against shared module state. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHubPRRefreshCandidate, PRInfo } from '../../shared/types'

const {
  sendMock,
  getAllWebContentsMock,
  getPRForBranchOutcomeMock,
  getRateLimitMock,
  rateLimitGuardMock
} = vi.hoisted(() => ({
  sendMock: vi.fn(),
  getAllWebContentsMock: vi.fn(),
  getPRForBranchOutcomeMock: vi.fn(),
  getRateLimitMock: vi.fn(),
  rateLimitGuardMock: vi.fn()
}))

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
  rateLimitGuard: rateLimitGuardMock
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
    mergeable: 'MERGEABLE',
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
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
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

  it('forwards the candidate worktree head into the branch lookup options', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValueOnce({
      kind: 'no-pr',
      fetchedAt: Date.now()
    })

    reportVisiblePRRefreshCandidates([makeCandidate({ currentHeadOid: 'worktree-head-oid' })], 1, 1)
    await vi.runOnlyPendingTimersAsync()

    // Why: without the head, a panel-supplied fallback number preserves a
    // merged PR head-blind after the branch moves on to new work.
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith(
      '/repo',
      'feature/test',
      null,
      null,
      null,
      expect.objectContaining({ currentHeadOid: 'worktree-head-oid' })
    )
  })

  it('copies the candidate worktree head onto broadcast aliases', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ state: 'merged' }),
      fetchedAt: Date.now()
    })

    reportVisiblePRRefreshCandidates([makeCandidate({ currentHeadOid: 'worktree-head-oid' })], 1, 1)
    await vi.runOnlyPendingTimersAsync()

    // Why: the renderer clear of a diverged merged linked PR is head-scoped, so
    // the broadcast alias must carry the request-time head it was probed against.
    const outcomeEvent = sendMock.mock.calls
      .map(([, event]) => event)
      .find((event) => event.outcome)
    expect(outcomeEvent?.aliases[0]?.currentHeadOid).toBe('worktree-head-oid')
  })

  it('does not show visible background refreshes as queued', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ checksStatus: 'pending', mergeable: 'MERGEABLE' }),
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
        pr: makePR({ checksStatus: 'pending', mergeable: 'MERGEABLE' }),
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

  it('paces a burst of distinct active refreshes', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'missing upstream',
      fetchedAt: Date.now()
    })

    for (let index = 0; index < 10; index += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::feature/${index}`,
          branch: `feature/${index}`,
          worktreeId: `wt-${index}`
        }),
        'active',
        80,
        1
      )
    }

    await vi.advanceTimersByTimeAsync(0)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
    expect(
      getPRForBranchOutcomeMock.mock.calls.map(([repoPath, branch]) => [repoPath, branch])
    ).toEqual([
      ['/repo', 'feature/9'],
      ['/repo', 'feature/8'],
      ['/repo', 'feature/7']
    ])

    await vi.advanceTimersByTimeAsync(29_999)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
    expect(
      sendMock.mock.calls
        .map(([, event]) => event)
        .some((event) => event.reason === 'active' && event.status === 'queued')
    ).toBe(true)

    await vi.advanceTimersByTimeAsync(1)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(6)
  })

  it('treats a same-key active reactivation as the latest active signal', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'missing upstream',
      fetchedAt: Date.now()
    })

    for (let index = 0; index < 10; index += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::feature/${index}`,
          branch: `feature/${index}`,
          worktreeId: `wt-${index}`
        }),
        'active',
        80,
        1
      )
    }
    await vi.advanceTimersByTimeAsync(0)

    enqueuePRRefresh(
      makeCandidate({
        cacheKey: '/repo::feature/0',
        branch: 'feature/0',
        worktreeId: 'wt-0'
      }),
      'active',
      80,
      1
    )
    await vi.advanceTimersByTimeAsync(30_000)

    expect(getPRForBranchOutcomeMock.mock.calls[3]?.[1]).toBe('feature/0')
  })

  it('does not let one capped active window block another window', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'missing upstream',
      fetchedAt: Date.now()
    })

    for (let index = 0; index < 10; index += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::feature/${index}`,
          branch: `feature/${index}`,
          worktreeId: `wt-${index}`
        }),
        'active',
        80,
        1
      )
    }
    enqueuePRRefresh(
      makeCandidate({
        cacheKey: '/repo::feature/other-window',
        branch: 'feature/other-window',
        worktreeId: 'wt-other-window'
      }),
      'active',
      80,
      2
    )

    await vi.advanceTimersByTimeAsync(0)

    expect(getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])).toContain(
      'feature/other-window'
    )
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(4)
  })

  it('does not let capped host active work block WSL or SSH active scopes', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'missing upstream',
      fetchedAt: Date.now()
    })

    for (let index = 0; index < 10; index += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::feature/${index}`,
          branch: `feature/${index}`,
          worktreeId: `wt-${index}`
        }),
        'active',
        80,
        1
      )
    }
    enqueuePRRefresh(
      makeCandidate({
        cacheKey: 'wsl::repo-1::feature/wsl',
        branch: 'feature/wsl',
        localGitOptions: { wslDistro: 'Ubuntu' },
        worktreeId: 'wt-wsl'
      }),
      'active',
      80,
      1
    )
    enqueuePRRefresh(
      makeCandidate({
        cacheKey: 'ssh:ssh-1::repo-1::feature/ssh',
        branch: 'feature/ssh',
        connectionId: 'ssh-1',
        worktreeId: 'wt-ssh'
      }),
      'active',
      80,
      1
    )

    await vi.advanceTimersByTimeAsync(0)

    const startedBranches = getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])
    expect(startedBranches).toContain('feature/wsl')
    expect(startedBranches).toContain('feature/ssh')
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(5)
  })

  it('does not let a capped active scope block ready visible work', async () => {
    const { enqueuePRRefresh, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'missing upstream',
      fetchedAt: Date.now()
    })

    for (let index = 0; index < 10; index += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::feature/${index}`,
          branch: `feature/${index}`,
          worktreeId: `wt-${index}`
        }),
        'active',
        80,
        1
      )
    }
    reportVisiblePRRefreshCandidates(
      [
        makeCandidate({
          cacheKey: '/repo::feature/visible',
          branch: 'feature/visible',
          worktreeId: 'wt-visible'
        })
      ],
      1,
      1
    )

    await vi.advanceTimersByTimeAsync(0)

    expect(getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])).toContain('feature/visible')
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(4)
  })

  it('wakes for visible budget spacing before a capped active burst opens', async () => {
    const { enqueuePRRefresh, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'missing upstream',
      fetchedAt: Date.now()
    })

    reportVisiblePRRefreshCandidates(
      [
        makeCandidate({
          cacheKey: '/repo::feature/visible-first',
          branch: 'feature/visible-first',
          worktreeId: 'wt-visible-first'
        })
      ],
      1,
      1
    )
    await vi.advanceTimersByTimeAsync(0)

    for (let index = 0; index < 10; index += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::feature/${index}`,
          branch: `feature/${index}`,
          worktreeId: `wt-${index}`
        }),
        'active',
        80,
        1
      )
    }
    reportVisiblePRRefreshCandidates(
      [
        makeCandidate({
          cacheKey: '/repo::feature/visible-second',
          branch: 'feature/visible-second',
          worktreeId: 'wt-visible-second'
        })
      ],
      2,
      1
    )

    await vi.advanceTimersByTimeAsync(0)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(4)

    await vi.advanceTimersByTimeAsync(9_999)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(4)

    await vi.advanceTimersByTimeAsync(1)

    expect(getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])).toContain(
      'feature/visible-second'
    )
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(5)
  })

  it('proceeds with background refreshes when the budget probe fails (fail open)', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    // Why: regression for #7553 — GHES with rate limiting disabled 404s every
    // probe; an unreadable budget must not pause refreshes.
    getRateLimitMock.mockResolvedValue({
      ok: false,
      error: 'HTTP 404: Rate limiting is not enabled.'
    })
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'no-pr',
      fetchedAt: Date.now()
    })

    enqueuePRRefresh(makeCandidate(), 'active', 80, 1)

    await vi.advanceTimersByTimeAsync(0)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    const pausedEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.status === 'paused' && event.skippedReason === 'rate-limit')
    expect(pausedEvents).toHaveLength(0)
  })

  it('does not consume active burst slots for rate-limit pauses', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    // Why: keyed on drained items (one getRateLimit call each) rather than
    // guard-call counts, so the guard's per-bucket evaluation order stays free
    // to change without breaking the slot-accounting assertion.
    let drainedItems = 0
    getRateLimitMock.mockImplementation(async () => {
      drainedItems += 1
      return { ok: true }
    })
    rateLimitGuardMock.mockImplementation(() =>
      drainedItems <= 3
        ? { blocked: true, remaining: 0, limit: 5000, resetAt: 61 }
        : { blocked: false }
    )
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'missing upstream',
      fetchedAt: Date.now()
    })

    for (let index = 0; index < 6; index += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::feature/${index}`,
          branch: `feature/${index}`,
          worktreeId: `wt-${index}`
        }),
        'active',
        80,
        1
      )
    }

    await vi.advanceTimersByTimeAsync(0)

    const pausedEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.status === 'paused' && event.skippedReason === 'rate-limit')
    expect(pausedEvents).toHaveLength(3)
    expect(getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])).toEqual([
      'feature/2',
      'feature/1',
      'feature/0'
    ])
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
      pr: makePR({ checksStatus: 'pending', mergeable: 'MERGEABLE' }),
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

  it('probes with the survivor head after the representative alias is invalidated', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ state: 'merged' }),
      fetchedAt: Date.now()
    })

    const survivor = makeCandidate({
      cacheKey: '/repo::feature/b',
      branch: 'feature/b',
      linkedPRNumber: 12,
      worktreeId: 'wt-b',
      currentHeadOid: 'head-b'
    })
    const representative = makeCandidate({
      cacheKey: '/repo::feature/a',
      branch: 'feature/a',
      linkedPRNumber: 12,
      worktreeId: 'wt-a',
      currentHeadOid: 'head-a'
    })

    // Enqueue the survivor first, then the representative (active coalescing
    // promotes the latter to representative), then invalidate the representative
    // so the still-queued entry rebinds to the survivor before draining.
    enqueuePRRefresh(survivor, 'active', 80, 1)
    enqueuePRRefresh(representative, 'active', 80, 1)
    enqueuePRRefresh({ ...representative, isArchived: true }, 'active', 80, 1)
    await vi.runOnlyPendingTimersAsync()

    const probedHeads = getPRForBranchOutcomeMock.mock.calls.map((call) => call[5]?.currentHeadOid)
    expect(probedHeads).toContain('head-b')
    expect(probedHeads).not.toContain('head-a')
  })

  it('probes with the survivor head after the representative worktree is pruned', async () => {
    const { enqueuePRRefresh, pruneWorktreePRRefreshAliases } =
      await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ state: 'merged' }),
      fetchedAt: Date.now()
    })

    const survivor = makeCandidate({
      cacheKey: '/repo::feature/b',
      branch: 'feature/b',
      linkedPRNumber: 12,
      worktreeId: 'wt-b',
      currentHeadOid: 'head-b'
    })
    const representative = makeCandidate({
      cacheKey: '/repo::feature/a',
      branch: 'feature/a',
      linkedPRNumber: 12,
      worktreeId: 'wt-a',
      currentHeadOid: 'head-a'
    })

    enqueuePRRefresh(survivor, 'active', 80, 1)
    enqueuePRRefresh(representative, 'active', 80, 1)
    pruneWorktreePRRefreshAliases('wt-a')
    await vi.runOnlyPendingTimersAsync()

    const probedHeads = getPRForBranchOutcomeMock.mock.calls.map((call) => call[5]?.currentHeadOid)
    expect(probedHeads).toContain('head-b')
    expect(probedHeads).not.toContain('head-a')
  })

  it('refreshes the representative head when the same worktree re-reports a moved head', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ state: 'merged' }),
      fetchedAt: Date.now()
    })

    // Same worktree/branch, moved head, coalescing visible→visible (no promote):
    // the representative head must track the newest report before the drain.
    reportVisiblePRRefreshCandidates(
      [makeCandidate({ linkedPRNumber: 12, worktreeId: 'wt-a', currentHeadOid: 'head-a' })],
      1,
      1
    )
    reportVisiblePRRefreshCandidates(
      [makeCandidate({ linkedPRNumber: 12, worktreeId: 'wt-a', currentHeadOid: 'head-b' })],
      2,
      1
    )
    await vi.runOnlyPendingTimersAsync()

    const probedHeads = getPRForBranchOutcomeMock.mock.calls.map((call) => call[5]?.currentHeadOid)
    expect(probedHeads).toContain('head-b')
    expect(probedHeads).not.toContain('head-a')
  })

  it('includes request start time on manual refresh events', async () => {
    const { refreshPRNow } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ checksStatus: 'success' }),
      fetchedAt: Date.now() + 5
    })

    await refreshPRNow(makeCandidate())

    const events = sendMock.mock.calls.map(([, event]) => event)
    const inFlight = events.find((event) => event.status === 'in-flight')
    const outcome = events.find((event) => event.outcome)
    expect(inFlight?.requestStartedAt).toBe(1_000)
    expect(outcome?.requestStartedAt).toBe(1_000)
    expect(outcome?.sequence).toBe(inFlight?.sequence)
  })

  it('accepts merged fallback PRs for visible fallback refreshes', async () => {
    const { refreshPRNow } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ state: 'merged' }),
      fetchedAt: Date.now()
    })

    await refreshPRNow(
      makeCandidate({
        fallbackPRNumber: 12,
        fallbackPRSource: 'pr-cache'
      })
    )

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledWith(
      '/repo',
      'feature/test',
      null,
      null,
      12,
      { acceptMergedFallbackPR: true }
    )
  })

  it('does not coalesce local and SSH refreshes for the same branch', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ number: 12 }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ number: 44 }),
        fetchedAt: Date.now()
      })

    enqueuePRRefresh(makeCandidate({ cacheKey: 'local::repo-1::feature/test' }), 'active', 80, 1)
    enqueuePRRefresh(
      makeCandidate({
        cacheKey: 'ssh:ssh-1::repo-1::feature/test',
        connectionId: 'ssh-1'
      }),
      'active',
      80,
      1
    )
    await vi.runOnlyPendingTimersAsync()
    await vi.runOnlyPendingTimersAsync()

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    expect(getPRForBranchOutcomeMock).toHaveBeenNthCalledWith(
      1,
      '/repo',
      'feature/test',
      null,
      null,
      null
    )
    expect(getPRForBranchOutcomeMock).toHaveBeenNthCalledWith(
      2,
      '/repo',
      'feature/test',
      null,
      'ssh-1',
      null
    )
  })

  it('does not coalesce host and WSL refreshes for the same local branch', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ number: 12 }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ number: 44 }),
        fetchedAt: Date.now()
      })

    enqueuePRRefresh(makeCandidate({ cacheKey: 'host::repo-1::feature/test' }), 'active', 80, 1)
    enqueuePRRefresh(
      makeCandidate({
        cacheKey: 'wsl::repo-1::feature/test',
        localGitOptions: { wslDistro: 'Ubuntu' }
      }),
      'active',
      80,
      1
    )
    await vi.runOnlyPendingTimersAsync()
    await vi.runOnlyPendingTimersAsync()

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    expect(getPRForBranchOutcomeMock).toHaveBeenNthCalledWith(
      1,
      '/repo',
      'feature/test',
      null,
      null,
      null
    )
    expect(getPRForBranchOutcomeMock).toHaveBeenNthCalledWith(
      2,
      '/repo',
      'feature/test',
      null,
      null,
      null,
      { localGitExecOptions: { wslDistro: 'Ubuntu' } }
    )
  })

  it('preserves coalesced aliases across visible follow-up refreshes', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'pending', mergeable: 'MERGEABLE' }),
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

  it('clears visible follow-ups when the owning window is destroyed', async () => {
    const {
      _getVisiblePRRefreshWindowCountForTests,
      clearVisiblePRRefreshWindow,
      reportVisiblePRRefreshCandidates
    } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ checksStatus: 'pending', mergeable: 'MERGEABLE' }),
      fetchedAt: Date.now()
    })

    reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.runOnlyPendingTimersAsync()

    expect(_getVisiblePRRefreshWindowCountForTests()).toBe(1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    clearVisiblePRRefreshWindow(1)
    await vi.advanceTimersByTimeAsync(90_000)

    expect(_getVisiblePRRefreshWindowCountForTests()).toBe(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('clears visible retry backoff when a non-visible manual refresh steals the retry', async () => {
    const {
      _getPRRefreshErrorBackoffCountForTests,
      refreshPRNow,
      reportVisiblePRRefreshCandidates
    } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'upstream-error',
        errorType: 'network',
        message: 'network down',
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success' }),
        fetchedAt: Date.now()
      })

    const candidate = makeCandidate()
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(_getPRRefreshErrorBackoffCountForTests()).toBe(1)

    getAllWebContentsMock.mockReturnValue([])
    await refreshPRNow(candidate)

    expect(_getPRRefreshErrorBackoffCountForTests()).toBe(0)
  })

  it('retries visible PRs with unknown mergeability before the success-check interval', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success', mergeable: 'UNKNOWN' }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success', mergeable: 'MERGEABLE' }),
        fetchedAt: Date.now()
      })

    reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(9_999)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('does a prompt visible follow-up after a manual refresh returns unknown mergeability', async () => {
    const { refreshPRNow, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    const visibleCandidate = makeCandidate()
    const candidate = makeCandidate({
      cachedFetchedAt: Date.now(),
      cachedHasPR: true,
      cachedPRState: 'open',
      cachedChecksStatus: 'success',
      cachedMergeable: 'MERGEABLE',
      cachedMergeStateStatus: 'CLEAN'
    })
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success', mergeable: 'MERGEABLE' }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success', mergeable: 'UNKNOWN' }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success', mergeable: 'CONFLICTING' }),
        fetchedAt: Date.now()
      })

    reportVisiblePRRefreshCandidates([visibleCandidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    await refreshPRNow(candidate)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(2_499)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
  })

  describe('pruneWorktreePRRefreshAliases', () => {
    // Several local worktrees tracking the same linked PR coalesce into one
    // queue entry (same refreshKey) whose alias map keeps one entry each.
    const LINKED_PR_KEY = 'local::runtime:host::/repo::pr::42'

    function makeLinkedCandidate(worktreeId: string): GitHubPRRefreshCandidate {
      return makeCandidate({
        worktreeId,
        cacheKey: `/repo::${worktreeId}`,
        branch: `feature/${worktreeId}`,
        linkedPRNumber: 42
      })
    }

    it('drops a removed worktree alias and deletes the entry when it was the last', async () => {
      const { enqueuePRRefresh, pruneWorktreePRRefreshAliases, _getPRRefreshAliasCountForTests } =
        await import('./pr-refresh-coordinator')

      enqueuePRRefresh(makeLinkedCandidate('wt-1'), 'visible', 40, 1)
      enqueuePRRefresh(makeLinkedCandidate('wt-2'), 'visible', 40, 1)
      enqueuePRRefresh(makeLinkedCandidate('wt-3'), 'visible', 40, 1)
      expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(3)

      pruneWorktreePRRefreshAliases('wt-2')
      expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(2)

      pruneWorktreePRRefreshAliases('wt-1')
      pruneWorktreePRRefreshAliases('wt-3')
      // Last alias gone -> the whole queue entry is dropped.
      expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(0)
    })

    it('keeps the entry alive and rebinds the candidate when other aliases remain', async () => {
      const {
        enqueuePRRefresh,
        pruneWorktreePRRefreshAliases,
        _getPRRefreshAliasCountForTests,
        _getPRRefreshQueueSizeForTests
      } = await import('./pr-refresh-coordinator')

      // wt-1 becomes the entry's representative candidate (enqueued first).
      enqueuePRRefresh(makeLinkedCandidate('wt-1'), 'visible', 40, 1)
      enqueuePRRefresh(makeLinkedCandidate('wt-2'), 'visible', 40, 1)
      expect(_getPRRefreshQueueSizeForTests()).toBe(1)

      // Removing the representative worktree must not orphan the entry.
      pruneWorktreePRRefreshAliases('wt-1')
      expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(1)
      expect(_getPRRefreshQueueSizeForTests()).toBe(1)
    })

    it('is a no-op for a worktree with no queued aliases', async () => {
      const { enqueuePRRefresh, pruneWorktreePRRefreshAliases, _getPRRefreshAliasCountForTests } =
        await import('./pr-refresh-coordinator')

      enqueuePRRefresh(makeLinkedCandidate('wt-1'), 'visible', 40, 1)
      pruneWorktreePRRefreshAliases('wt-unknown')
      expect(_getPRRefreshAliasCountForTests(LINKED_PR_KEY)).toBe(1)
    })
  })
})
