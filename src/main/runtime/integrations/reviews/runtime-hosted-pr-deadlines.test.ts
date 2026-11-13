import { expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { makeCandidate } from '../../../github/pull-requests/refresh/pr-refresh-coordinator-test-harness'
import { fixture, found, mocks, read, rpcRead } from './runtime-hosted-pr-snapshot-test-harness'

it('delivers post-push data while another row waits for a later rate-limit reset', async () => {
  const coordinator = await import('../../../github/pull-requests/refresh/pr-refresh-coordinator')
  const delivered: PRRefreshOutcome[] = []
  const remove = coordinator.addPRRefreshOutcomeObserver((_candidate, outcome) =>
    delivered.push(outcome)
  )
  const candidate = (branch: string) =>
    makeCandidate({
      branch,
      cacheKey: `/repo::${branch}`,
      currentHeadOid: 'head-a'
    })
  try {
    fixture.title = 'after push'
    mocks.gate.mockImplementation(async (row) => (row.branch === 'later' ? 61_000 : null))
    coordinator.enqueuePRRefresh(candidate('pushed'), 'post-push')
    await vi.advanceTimersByTimeAsync(0)
    await coordinator.refreshPRNow(candidate('later'))
    await vi.advanceTimersByTimeAsync(2_500)
    expect(delivered).toContainEqual({
      kind: 'found',
      fetchedAt: 3_500,
      pr: expect.objectContaining({ title: 'after push' })
    })
  } finally {
    remove()
  }
})

it.each(['deadline', 'abort'] as const)(
  'detaches an automatic cold-read waiter on %s while its producer completes for another client',
  async (end) => {
    const result = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockReturnValueOnce(result.promise)
    const producer = read('pending', 'active')
    await vi.advanceTimersByTimeAsync(0)
    const controller = new AbortController()
    const joined = rpcRead(
      {
        repo: 'repo',
        branch: 'pending',
        currentHeadOid: 'head-a',
        reason: 'swr',
        acceptRevalidationOnly: true
      },
      controller.signal
    )
    const abandoned =
      end === 'abort'
        ? expect(joined).rejects.toThrow('cancelled')
        : expect(joined).resolves.toMatchObject({ revalidation: { retryAfterMs: 10_000 } })
    await vi.advanceTimersByTimeAsync(0)
    if (end === 'abort') {
      controller.abort()
    } else {
      await vi.advanceTimersByTimeAsync(25_000)
    }
    await abandoned
    fixture.title = 'producer completed'
    result.resolve(found())
    await expect(producer).resolves.toMatchObject({ pr: { title: 'producer completed' } })
    await expect(read('pending')).resolves.toMatchObject({ pr: { title: 'producer completed' } })
  }
)
