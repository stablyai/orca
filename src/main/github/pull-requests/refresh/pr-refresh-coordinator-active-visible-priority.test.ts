import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRInfo } from '../../../../shared/github/pull-requests/pull-request-types'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('./pr-refresh-renderer-port', () => moduleMocks.rendererPortModuleMock(coordinatorMocks))
vi.mock('../../client/lookup/pr-for-branch-outcome', () => {
  return {
    getPRForBranchOutcome: coordinatorMocks.getPRForBranchOutcomeMock
  }
})
vi.mock('../../repositories/github-api-repository-remote-probe', () => {
  return {
    getOriginGitHubApiRepository: coordinatorMocks.getOriginGitHubApiRepositoryMock
  }
})
vi.mock('../../api/rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))

import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const { sendMock, getPRForBranchOutcomeMock } = coordinatorMocks

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
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
  })

  afterEach(() => {
    vi.useRealTimers()
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
})
