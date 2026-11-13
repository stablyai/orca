import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'

import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

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

const { getPRForBranchOutcomeMock } = coordinatorMocks

function found(state: 'open' | 'closed' | 'merged'): PRRefreshOutcome {
  return { kind: 'found', pr: makePR({ state, checksStatus: 'success' }), fetchedAt: Date.now() }
}

describe('main refresh completion ordering', () => {
  beforeEach(() => moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks))
  afterEach(() => vi.useRealTimers())

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
})
