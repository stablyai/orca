import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'
import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

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

const { getPRForBranchOutcomeMock, getOriginGitHubApiRepositoryMock, sendMock } = coordinatorMocks

function found(state: 'open' | 'closed' | 'merged'): PRRefreshOutcome {
  return { kind: 'found', pr: makePR({ state, checksStatus: 'success' }), fetchedAt: Date.now() }
}

describe('main refresh completion ordering', () => {
  beforeEach(() => moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks))
  afterEach(() => vi.useRealTimers())

  it.each([
    { older: 'open', newer: 'merged' },
    { older: 'closed', newer: 'open' }
  ] as const)(
    'ignores expired coalesced $older reads after a newer $newer result',
    async ({ older, newer }) => {
      const reads: CoalescedProbes<PRRefreshOutcome> = new Map()
      let finishOlder: (outcome: PRRefreshOutcome) => void = () => {}
      const provider = vi.fn<() => Promise<PRRefreshOutcome>>()
      provider
        .mockImplementationOnce(
          () => new Promise<PRRefreshOutcome>((resolve) => (finishOlder = resolve))
        )
        .mockImplementation(async () => found(newer))
      getPRForBranchOutcomeMock.mockImplementation(() =>
        runCoalescedProbe(reads, 'same-provider-lookup', provider, 120_000)
      )
      const {
        reportVisiblePRRefreshCandidates,
        refreshPRNow,
        setPRRefreshOutcomeObserver,
        _getPRRefreshQueueSizeForTests
      } = await import('./pr-refresh-coordinator')
      const observer = vi.fn()
      setPRRefreshOutcomeObserver(observer)
      const candidate = makeCandidate({ isSelected: true })
      reportVisiblePRRefreshCandidates([candidate], 1, 1)
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(120_000)
      await refreshPRNow(candidate)
      expect(provider).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1_000)
      finishOlder(found(older))
      await vi.advanceTimersByTimeAsync(0)
      expect(observer).toHaveBeenCalledTimes(1)
      expect(observer.mock.calls[0]?.[1]).toMatchObject({ pr: { state: newer } })
      expect(_getPRRefreshQueueSizeForTests()).toBe(newer === 'merged' ? 0 : 1)
      await vi.advanceTimersByTimeAsync(59_000)
      expect(provider).toHaveBeenCalledTimes(newer === 'merged' ? 2 : 3)
      if (newer === 'merged') {
        await vi.advanceTimersByTimeAsync(900_000)
        expect(provider).toHaveBeenCalledTimes(2)
      }
    }
  )

  it.each(['network', 'rate_limited'] as const)(
    'ignores a late %s error after a newer settled result',
    async (errorType) => {
      let finishOlder: (outcome: PRRefreshOutcome) => void = () => {}
      getPRForBranchOutcomeMock
        .mockImplementationOnce(
          () => new Promise<PRRefreshOutcome>((resolve) => (finishOlder = resolve))
        )
        .mockImplementation(async () => found('merged'))
      const {
        reportVisiblePRRefreshCandidates,
        refreshPRNow,
        _getPRRefreshErrorBackoffCountForTests,
        _getPRRefreshQueueSizeForTests
      } = await import('./pr-refresh-coordinator')
      const candidate = makeCandidate({ isSelected: true })
      reportVisiblePRRefreshCandidates([candidate], 1, 1)
      await vi.advanceTimersByTimeAsync(0)
      await refreshPRNow(candidate)
      finishOlder({
        kind: 'upstream-error',
        errorType,
        message: 'old failure',
        fetchedAt: Date.now(),
        retryDisabledUntil: Date.now() + 300_000
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(_getPRRefreshErrorBackoffCountForTests()).toBe(0)
      expect(_getPRRefreshQueueSizeForTests()).toBe(0)
      await refreshPRNow(candidate)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
    }
  )

  it('fences older direct refresh completions without suppressing their caller result', async () => {
    let finishOlder: (outcome: PRRefreshOutcome) => void = () => {}
    getPRForBranchOutcomeMock
      .mockImplementationOnce(
        () => new Promise<PRRefreshOutcome>((resolve) => (finishOlder = resolve))
      )
      .mockImplementation(async () => found('merged'))
    const { refreshPRNow, setPRRefreshOutcomeObserver } = await import('./pr-refresh-coordinator')
    const observer = vi.fn()
    setPRRefreshOutcomeObserver(observer)
    const candidate = makeCandidate()
    const older = refreshPRNow(candidate)
    await vi.advanceTimersByTimeAsync(0)
    await refreshPRNow(candidate)
    finishOlder(found('closed'))
    await expect(older).resolves.toMatchObject({ pr: { state: 'closed' } })
    expect(observer).toHaveBeenCalledTimes(1)
    expect(sendMock.mock.calls.filter(([, event]) => event.outcome)).toHaveLength(2)
  })

  it('preserves a newer failure gate when an older successful lookup completes', async () => {
    let finishOlder: (outcome: PRRefreshOutcome) => void = () => {}
    getPRForBranchOutcomeMock
      .mockImplementationOnce(
        () => new Promise<PRRefreshOutcome>((resolve) => (finishOlder = resolve))
      )
      .mockImplementation(async () => ({
        kind: 'upstream-error',
        errorType: 'rate_limited',
        message: 'wait',
        fetchedAt: Date.now(),
        retryDisabledUntil: Date.now() + 300_000
      }))
    const { reportVisiblePRRefreshCandidates, refreshPRNow } =
      await import('./pr-refresh-coordinator')
    const candidate = makeCandidate({ isSelected: true })
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    await refreshPRNow(candidate)
    finishOlder(found('open'))
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    await expect(refreshPRNow(candidate)).resolves.toMatchObject({ errorType: 'rate_limited' })
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a shared provider read coalesced while only the newest caller adopts it', async () => {
    const reads: CoalescedProbes<PRRefreshOutcome> = new Map()
    let finish: (outcome: PRRefreshOutcome) => void = () => {}
    const provider = vi.fn(() => new Promise<PRRefreshOutcome>((resolve) => (finish = resolve)))
    getPRForBranchOutcomeMock.mockImplementation(() =>
      runCoalescedProbe(reads, 'same-provider-lookup', provider, 120_000)
    )
    const { reportVisiblePRRefreshCandidates, refreshPRNow, setPRRefreshOutcomeObserver } =
      await import('./pr-refresh-coordinator')
    const observer = vi.fn()
    setPRRefreshOutcomeObserver(observer)
    const candidate = makeCandidate({ isSelected: true })
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    const manual = refreshPRNow(candidate)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    expect(provider).toHaveBeenCalledTimes(1)
    finish(found('merged'))
    await manual
    await vi.advanceTimersByTimeAsync(900_000)
    expect(observer).toHaveBeenCalledTimes(1)
    expect(provider).toHaveBeenCalledTimes(1)
  })

  it('does not start an older queued read when admission finishes after a newer direct read', async () => {
    let finishAdmission: () => void = () => {}
    getOriginGitHubApiRepositoryMock.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          finishAdmission = () => resolve(null)
        })
    )
    getPRForBranchOutcomeMock.mockImplementation(async () => found('merged'))
    const { reportVisiblePRRefreshCandidates, refreshPRNow } =
      await import('./pr-refresh-coordinator')
    const candidate = makeCandidate({ isSelected: true })
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    await refreshPRNow(candidate)
    finishAdmission()
    await vi.advanceTimersByTimeAsync(900_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })
})
