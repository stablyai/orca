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
})
