import { expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { makeCandidate } from '../../../github/pull-requests/refresh/pr-refresh-coordinator-test-harness'
import { fixture, found, mocks, read, rpcRead } from './runtime-hosted-pr-snapshot-test-harness'

it('delivers an unrelated row without a spacing delay after joining an existing producer', async () => {
  const coordinator = await import('../../../github/pull-requests/refresh/pr-refresh-coordinator')
  const result = Promise.withResolvers<PRRefreshOutcome>()
  mocks.resolve.mockReturnValueOnce(result.promise)
  const producer = read('joining', 'active')
  await vi.advanceTimersByTimeAsync(0)
  const delivered: { branch: string; outcome: PRRefreshOutcome }[] = []
  const remove = coordinator.addPRRefreshOutcomeObserver((candidate, outcome) => {
    delivered.push({ branch: candidate.branch, outcome })
  })
  try {
    for (const branch of ['joining', 'unrelated']) {
      coordinator.enqueuePRRefresh(
        makeCandidate({ branch, cacheKey: `/repo::${branch}`, currentHeadOid: 'head-a' }),
        'swr'
      )
    }
    await vi.advanceTimersByTimeAsync(0)
    fixture.title = 'shared answer'
    result.resolve(found())
    await producer
    await vi.advanceTimersByTimeAsync(0)
    expect(delivered).toContainEqual({
      branch: 'unrelated',
      outcome: {
        kind: 'found',
        fetchedAt: 1_000,
        pr: expect.objectContaining({ title: 'shared answer' })
      }
    })
  } finally {
    remove()
  }
})

it.each([false, true])(
  'delivers post-push data while another row waits for a later rate-limit reset (clock jump: %s)',
  async (clockJump) => {
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
      if (clockJump) {
        await coordinator.refreshPRNow(candidate('later'))
        vi.setSystemTime(301_000)
      }
      coordinator.enqueuePRRefresh(candidate('pushed'), 'post-push')
      await vi.advanceTimersByTimeAsync(0)
      if (!clockJump) {
        await coordinator.refreshPRNow(candidate('later'))
      }
      await vi.advanceTimersByTimeAsync(2_500)
      expect(delivered).toContainEqual({
        kind: 'found',
        fetchedAt: clockJump ? 303_500 : 3_500,
        pr: expect.objectContaining({ title: 'after push' })
      })
    } finally {
      remove()
    }
  }
)

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
