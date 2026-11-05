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

  it('ignores a stale visibility generation before it can replace queued work', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({ kind: 'no-pr', fetchedAt: Date.now() })

    reportVisiblePRRefreshCandidates(
      [makeCandidate({ branch: 'feature/current', cacheKey: '/repo::feature/current' })],
      2,
      1
    )
    reportVisiblePRRefreshCandidates(
      [makeCandidate({ branch: 'feature/stale', cacheKey: '/repo::feature/stale' })],
      1,
      1
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledOnce()
    expect(getPRForBranchOutcomeMock.mock.calls[0]?.[1]).toBe('feature/current')
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

  it('keeps each manual outcome on its request sequence when completions race', async () => {
    const { refreshPRNow } = await import('./pr-refresh-coordinator')
    let resolveFirst!: (outcome: ReturnType<typeof makePR>) => void
    let resolveSecond!: (outcome: ReturnType<typeof makePR>) => void
    const first = new Promise<ReturnType<typeof makePR>>((resolve) => {
      resolveFirst = resolve
    })
    const second = new Promise<ReturnType<typeof makePR>>((resolve) => {
      resolveSecond = resolve
    })
    getPRForBranchOutcomeMock
      .mockImplementationOnce(async () => ({
        kind: 'found',
        pr: await first,
        fetchedAt: Date.now()
      }))
      .mockImplementationOnce(async () => ({
        kind: 'found',
        pr: await second,
        fetchedAt: Date.now()
      }))

    const firstRefresh = refreshPRNow(makeCandidate())
    const secondRefresh = refreshPRNow(makeCandidate())
    await vi.advanceTimersByTimeAsync(0)
    resolveSecond(makePR({ number: 22 }))
    await secondRefresh
    resolveFirst(makePR({ number: 11 }))
    await firstRefresh

    const events = sendMock.mock.calls.map(([, event]) => event)
    const inFlight = events.filter((event) => event.status === 'in-flight')
    const outcomes = events.filter((event) => event.outcome)
    const firstOutcome = outcomes.find((event) => event.outcome.pr?.number === 11)
    const secondOutcome = outcomes.find((event) => event.outcome.pr?.number === 22)
    expect(firstOutcome?.sequence).toBe(inFlight[0]?.sequence)
    expect(secondOutcome?.sequence).toBe(inFlight[1]?.sequence)
    expect(firstOutcome?.sequence).toBeLessThan(secondOutcome?.sequence)
  })
})
