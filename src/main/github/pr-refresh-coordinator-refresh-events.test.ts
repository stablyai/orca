import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(coordinatorMocks))
vi.mock('./client', () => moduleMocks.clientModuleMock(coordinatorMocks))
vi.mock('./github-api-repository', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))
vi.mock('../ipc/ui', () => moduleMocks.ipcUiModuleMock(coordinatorMocks))

import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const { sendMock, sendToTrustedUIRendererMock, getAllWebContentsMock, getPRForBranchOutcomeMock } =
  coordinatorMocks

describe('pr-refresh-coordinator', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends each refresh event once without broadcasting to 100 browser guests', async () => {
    const guestSends = Array.from({ length: 100 }, () => vi.fn())
    getAllWebContentsMock.mockReturnValue(
      guestSends.map((send, index) => ({
        id: index + 100,
        isDestroyed: () => false,
        send
      }))
    )
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')

    enqueuePRRefresh(makeCandidate({ isBare: true }), 'manual')

    expect(sendToTrustedUIRendererMock).toHaveBeenCalledOnce()
    expect(sendToTrustedUIRendererMock).toHaveBeenCalledWith(
      'gh:prRefreshEvent',
      expect.objectContaining({ status: 'skipped', skippedReason: 'bare' })
    )
    expect(sendMock).toHaveBeenCalledOnce()
    expect(getAllWebContentsMock).not.toHaveBeenCalled()
    expect(guestSends.reduce((total, send) => total + send.mock.calls.length, 0)).toBe(0)
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
})
