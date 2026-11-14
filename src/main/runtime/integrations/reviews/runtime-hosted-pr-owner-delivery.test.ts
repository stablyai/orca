import { expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { commands, fixture, found, mocks, read } from './runtime-hosted-pr-snapshot-test-harness'

it('returns completed legacy cold and pending replies without fallback IO or a successor wait', async () => {
  const { preparePRBranchRead } =
    await import('../../../github/client/lookup/pr-for-branch-outcome')
  const { addPRRefreshOutcomeObserver } =
    await import('../../../github/pull-requests/refresh/pr-refresh-coordinator')
  const releases: (() => void)[] = []
  const observe = vi.fn()
  const remove = addPRRefreshOutcomeObserver(observe)
  try {
    for (let index = 0; index < 256; index++) {
      const branch = `protected-${index}`
      await read(branch, 'active')
      const prepared = await preparePRBranchRead('/repo', branch, null, null, null, {
        currentHeadOid: 'head-a'
      })
      releases.push(prepared.hold())
    }
    mocks.resolve.mockClear()
    observe.mockClear()
    for (const freshFirst of [true, false]) {
      const branch = freshFirst ? 'legacy-finished-successor' : 'legacy-running-successor'
      const old = Promise.withResolvers<PRRefreshOutcome>()
      const fresh = Promise.withResolvers<PRRefreshOutcome>()
      mocks.resolve.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
      const legacy = () =>
        commands.getRepoPRForBranch('repo', branch, null, null, false, 'head-a', 'swr')
      const first = legacy()
      await vi.advanceTimersByTimeAsync(0)
      const sibling = legacy()
      await vi.advanceTimersByTimeAsync(0)
      const foreground = read(branch, 'active')
      await vi.advanceTimersByTimeAsync(0)
      const delivered = vi.fn()
      const completed = Promise.all([first, sibling]).then(delivered)
      try {
        expect(await read(branch)).toEqual({
          revalidation: { invalidated: true, retryAfterMs: 10_000 }
        })
        if (freshFirst) {
          fresh.resolve(found())
          await foreground
        }
        const own: PRRefreshOutcome = { kind: 'no-pr', fetchedAt: 1_000 }
        old.resolve(own)
        await vi.advanceTimersByTimeAsync(0)
        expect(delivered).toHaveBeenCalledWith([own, own])
      } finally {
        old.resolve({ kind: 'no-pr', fetchedAt: 1_000 })
        fresh.resolve(found())
        await Promise.all([completed, foreground])
      }
    }
    expect(mocks.resolve).toHaveBeenCalledTimes(4)
    expect(observe).toHaveBeenCalledTimes(2)
  } finally {
    for (const release of releases) {
      release()
    }
    remove()
  }
  fixture.title = 'legitimate automatic read'
  expect(await read('after-capacity')).toMatchObject({ pr: { title: 'legitimate automatic read' } })
})

it.each(['generation-cold', 'account-cold', 'account-direct'] as const)(
  'fences %s settlement before obsolete error policy and observation',
  async (change) => {
    const { addPRRefreshOutcomeObserver, _getPRRefreshErrorBackoffCountForTests } =
      await import('../../../github/pull-requests/refresh/pr-refresh-coordinator')
    const { invalidateHostedReviewBranchCache } =
      await import('../../../source-control/hosted-review-branch-cache')
    const observe = vi.fn()
    const remove = addPRRefreshOutcomeObserver(observe)
    const provider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.account.mockReturnValue({ ghAccount: { host: 'github.com', user: 'before' } })
    mocks.resolve.mockReturnValueOnce(provider.promise)
    const pending = read('scope', change === 'account-direct' ? 'active' : 'swr')
    await vi.advanceTimersByTimeAsync(0)
    if (change === 'generation-cold') {
      invalidateHostedReviewBranchCache('/repo', 'local')
    } else {
      mocks.account.mockReturnValue({ ghAccount: { host: 'github.com', user: 'after' } })
    }
    try {
      provider.reject(new Error('network offline'))
      const result = await pending
      if (change === 'account-direct') {
        expect(result).toMatchObject({ kind: 'upstream-error' })
      } else {
        expect(result).toEqual({ revalidation: { invalidated: true, retryAfterMs: 10_000 } })
      }
      expect(observe).not.toHaveBeenCalled()
      expect(_getPRRefreshErrorBackoffCountForTests()).toBe(0)
      fixture.title = 'current scope'
      expect(await read('scope', 'active')).toMatchObject({ pr: { title: 'current scope' } })
      expect(observe).toHaveBeenCalledTimes(1)
    } finally {
      remove()
    }
  }
)
