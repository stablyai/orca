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

import { makeCandidate } from './pr-refresh-coordinator-test-harness'
import { PRRefreshQueue } from './pr-refresh-queue'

const { getPRForBranchOutcomeMock } = coordinatorMocks

describe('failed main refresh pacing', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'upstream-error',
      errorType: 'network',
      message: 'offline',
      fetchedAt: Date.now()
    }))
  })
  afterEach(() => vi.useRealTimers())

  it.each([
    { cachedPRState: 'open', cachedHasPR: true, isSelected: true, interval: 60_000 },
    { cachedPRState: 'open', cachedHasPR: true, isSelected: false, interval: 120_000 },
    { cachedPRState: 'closed', cachedHasPR: true, isSelected: true, interval: 900_000 },
    { cachedPRState: null, cachedHasPR: false, isSelected: false, interval: 900_000 },
    { cachedPRState: null, cachedHasPR: false, isSelected: true, interval: 60_000 },
    { cachedPRState: 'merged', cachedHasPR: true, isSelected: false, interval: 60_000 }
  ] as const)(
    'keeps $cachedPRState selected=$isSelected retries behind $interval ms',
    async ({ interval, ...state }) => {
      const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
      reportVisiblePRRefreshCandidates(
        [makeCandidate({ ...state, cachedChecksStatus: 'success' })],
        1,
        1
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(interval - 1)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(Math.max(interval, 120_000) - 1)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
    }
  )

  it('panel foreground exposure cannot bypass a failed lookup deadline', async () => {
    const { reportVisiblePRRefreshCandidates, enqueuePRRefresh } =
      await import('./pr-refresh-coordinator')
    const candidate = makeCandidate({ isSelected: true })
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    enqueuePRRefresh(candidate, 'visible', 80, 1)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('keeps request ownership bounded and rejects evicted completions', () => {
    const queue = new PRRefreshQueue(() => {})
    for (let sequence = 1; sequence <= 1_001; sequence++) {
      queue.noteRequestStarted(`branch-${sequence}`, sequence)
    }
    expect(queue.ownsRequest('branch-1', 1)).toBe(false)
    expect(queue.ownsRequest('branch-1001', 1_001)).toBe(true)
    queue.protectBackgroundUntil('branch-1001', Date.now() + 300_000)
    expect(queue.ownsRequest('branch-1001', 1_001)).toBe(true)
    queue.noteRequestStarted('branch-1001', 1_002)
    expect(queue.ownsRequest('branch-1001', 1_001)).toBe(false)
    expect(queue.ownsRequest('branch-1001', 1_002)).toBe(true)
  })
})
