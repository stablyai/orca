import { describe, expect, it, vi } from 'vitest'
import { makeCandidate } from '../../../github/pull-requests/refresh/pr-refresh-coordinator-test-harness'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { registerPRProducerSettlementTests } from './hosted-pr-producer-settlement-test-cases'
import { commands, fixture, found, mocks, read } from './runtime-hosted-pr-snapshot-test-harness'

describe('hosted PR snapshots', () => {
  it('shares true-aged timer data while legacy discovery and actions read current data', async () => {
    await read('shared', 'active')
    fixture.title = 'after'
    expect(await read('shared')).toMatchObject({
      kind: 'found',
      pr: { title: 'before' },
      fetchedAt: 1_000
    })
    vi.setSystemTime(2_000)
    expect(await read('shared', 'visible')).toMatchObject({
      kind: 'found',
      pr: { title: 'after' },
      fetchedAt: 2_000
    })
    fixture.title = 'manual'
    expect(await read('shared', 'manual')).toMatchObject({ kind: 'found', pr: { title: 'manual' } })
  })

  it('keeps a confirmed unchanged quiet result, but a different request head reads again', async () => {
    await read('quiet', 'active')
    await vi.advanceTimersByTimeAsync(60_000)
    const confirmation = read('quiet')
    await vi.advanceTimersByTimeAsync(0)
    expect(await confirmation).toMatchObject({ fetchedAt: 61_000 })
    await vi.advanceTimersByTimeAsync(120_000)
    fixture.title = 'new provider state'
    expect(await read('quiet')).toMatchObject({ pr: { title: 'before' }, fetchedAt: 61_000 })
    expect(await read('quiet', 'swr', 'head-b')).toMatchObject({
      pr: { title: 'new provider state' },
      fetchedAt: 181_000
    })
  })

  it('returns completed checks in each due response for three queued rows', async () => {
    await Promise.all(['one', 'two', 'three'].map((branch) => read(branch, 'active')))
    fixture.title = 'finished checks'
    mocks.resolve.mockImplementation(
      () =>
        new Promise<PRRefreshOutcome>((resolve) => {
          // ast-grep-ignore: test-no-real-time-wait -- Fake-clock provider delay exercises host admission and completion.
          setTimeout(() => resolve(found()), 1_000)
        })
    )
    await vi.advanceTimersByTimeAsync(60_000)
    const responses = Promise.all(['one', 'two', 'three'].map((branch) => read(branch)))
    await vi.advanceTimersByTimeAsync(21_000)
    expect(await responses).toEqual([
      expect.objectContaining({ pr: expect.objectContaining({ title: 'finished checks' }) }),
      expect.objectContaining({ pr: expect.objectContaining({ title: 'finished checks' }) }),
      expect.objectContaining({ pr: expect.objectContaining({ title: 'finished checks' }) })
    ])
  })

  it('delivers a deferred provider failure to the next timer instead of reviving old success', async () => {
    await read('slow', 'active')
    const provider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockImplementation(() => provider.promise)
    await vi.advanceTimersByTimeAsync(60_000)
    const waiting = read('slow')
    await vi.advanceTimersByTimeAsync(25_000)
    expect(await waiting).toMatchObject({
      kind: 'found',
      fetchedAt: 1_000,
      revalidation: { retryAfterMs: 10_000 }
    })
    provider.reject(new Error('network down'))
    await vi.advanceTimersByTimeAsync(0)
    expect(await read('slow')).toMatchObject({ kind: 'upstream-error' })
    mocks.resolve.mockImplementation(async () => found())
    fixture.title = 'manual recovery'
    expect(await read('slow', 'manual')).toMatchObject({ pr: { title: 'manual recovery' } })
  })

  it('retrieves a queued completion on its short retry after local work delays admission', async () => {
    await Promise.all(['one', 'two', 'three'].map((branch) => read(branch, 'active')))
    mocks.resolve.mockImplementation(
      ({ branchName }) =>
        new Promise<PRRefreshOutcome>((resolve) => {
          // ast-grep-ignore: test-no-real-time-wait -- Fake-clock provider delay exercises host admission and completion.
          setTimeout(() => resolve(found()), branchName === 'blocking' ? 6_000 : 1_000)
        })
    )
    await vi.advanceTimersByTimeAsync(60_000)
    const { enqueuePRRefresh } =
      await import('../../../github/pull-requests/refresh/pr-refresh-coordinator')
    enqueuePRRefresh(makeCandidate({ branch: 'blocking' }), 'active')
    await vi.advanceTimersByTimeAsync(0)
    fixture.title = 'delivered'
    const responses = Promise.all(['one', 'two', 'three'].map((branch) => read(branch)))
    await vi.advanceTimersByTimeAsync(25_000)
    expect(await responses).toMatchObject([
      { pr: { title: 'delivered' } },
      { pr: { title: 'delivered' } },
      { pr: { title: 'before' }, revalidation: { retryAfterMs: 10_000 } }
    ])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await read('three')).toMatchObject({ pr: { title: 'delivered' }, fetchedAt: 88_000 })
  })

  it('returns a no-data retry after the project account changes', async () => {
    mocks.account.mockReturnValue({ ghAccount: { host: 'github.com', user: 'before' } })
    await read('account', 'active')
    await vi.advanceTimersByTimeAsync(60_000)
    const gate = Promise.withResolvers<number | null>()
    mocks.gate.mockReturnValue(gate.promise)
    const waiting = read('account')
    await vi.advanceTimersByTimeAsync(0)
    mocks.account.mockReturnValue({ ghAccount: { host: 'github.com', user: 'after' } })
    gate.resolve(null)
    await vi.advanceTimersByTimeAsync(0)
    expect(await waiting).toEqual({ revalidation: { invalidated: true, retryAfterMs: 10_000 } })
    fixture.title = 'new account'
    expect(await read('account')).toMatchObject({ pr: { title: 'new account' } })
  })

  it('cancels one client wait while another receives the shared provider result', async () => {
    await read('cancel', 'active')
    await vi.advanceTimersByTimeAsync(60_000)
    const provider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockReturnValue(provider.promise)
    const controller = new AbortController()
    const cancelled = commands.getRepoPRForBranch(
      'repo',
      'cancel',
      null,
      null,
      false,
      'head-a',
      'swr',
      false,
      undefined,
      controller.signal,
      true
    )
    const rejected = expect(cancelled).rejects.toThrow('cancelled')
    const remaining = read('cancel')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await rejected
    fixture.title = 'shared completion'
    provider.resolve(found())
    await vi.advanceTimersByTimeAsync(0)
    expect(await remaining).toMatchObject({ pr: { title: 'shared completion' } })
  })

  it('returns a receipt to excess waiters and keeps the shared result after cancellation', async () => {
    await read('many', 'active')
    await vi.advanceTimersByTimeAsync(60_000)
    const provider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockReturnValue(provider.promise)
    const controllers = Array.from({ length: 256 }, () => new AbortController())
    const waiting = controllers.map((controller) =>
      commands.getRepoPRForBranch(
        'repo',
        'many',
        null,
        null,
        false,
        'head-a',
        'swr',
        false,
        undefined,
        controller.signal,
        true
      )
    )
    const cancellations = Promise.allSettled(waiting)
    await vi.advanceTimersByTimeAsync(0)
    expect(await read('many')).toMatchObject({
      fetchedAt: 1_000,
      revalidation: { retryAfterMs: 10_000 }
    })
    for (const controller of controllers) {
      controller.abort()
    }
    await cancellations
    fixture.title = 'completed without waiters'
    provider.resolve(found())
    await vi.advanceTimersByTimeAsync(0)
    expect(await read('many')).toMatchObject({ pr: { title: 'completed without waiters' } })
  })

  it('lets a rate-limited job expire without starting it after demand stops', async () => {
    await read('lease', 'active')
    await vi.advanceTimersByTimeAsync(60_000)
    mocks.gate.mockResolvedValue(Date.now() + 900_000)
    const waiting = read('lease')
    await vi.advanceTimersByTimeAsync(25_000)
    expect(await waiting).toMatchObject({
      fetchedAt: 1_000,
      revalidation: { retryAfterMs: 875_000 }
    })
    fixture.title = 'not requested'
    await vi.advanceTimersByTimeAsync(900_000)
    const { readRecentPhonePROutcome } =
      await import('../../../github/client/lookup/pr-for-branch-outcome')
    expect(
      await readRecentPhonePROutcome('/repo', 'lease', null, null, null, {
        currentHeadOid: 'head-a'
      })
    ).toBeNull()
    mocks.gate.mockResolvedValue(null)
    expect(await read('lease', 'manual')).toMatchObject({ pr: { title: 'not requested' } })
  })
  it('retains the exact late error and budget gate after narrowed and other-head writes, then recovers', async () => {
    await read('retained', 'active')
    await vi.advanceTimersByTimeAsync(60_000)
    const provider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockReturnValueOnce(provider.promise)
    const waiting = read('retained')
    await vi.advanceTimersByTimeAsync(25_000)
    expect(await waiting).toMatchObject({ revalidation: { retryAfterMs: 10_000 } })
    provider.resolve({
      kind: 'upstream-error',
      errorType: 'network',
      message: 'offline',
      fetchedAt: Date.now()
    })
    await vi.advanceTimersByTimeAsync(0)
    const { getPRForBranchOutcome } =
      await import('../../../github/client/lookup/pr-for-branch-outcome')
    await getPRForBranchOutcome('/repo', 'retained', null, null, null, {
      currentHeadOid: 'head-a',
      includeDerivedData: false
    })
    await read('retained', 'active', 'head-b')
    const before = mocks.resolve.mock.calls.length
    const error = await read('retained')
    expect(error).toMatchObject({
      kind: 'upstream-error',
      message: 'offline',
      nextAutoRetryAt: expect.any(Number)
    })
    expect(mocks.resolve).toHaveBeenCalledTimes(before)
    if (!('kind' in error) || error.kind !== 'upstream-error') {
      throw new Error('expected the actual provider failure')
    }
    await vi.advanceTimersByTimeAsync(error.nextAutoRetryAt! - Date.now())
    fixture.title = 'recovered'
    const recovered = read('retained')
    await vi.advanceTimersByTimeAsync(0)
    expect(await recovered).toMatchObject({ kind: 'found', pr: { title: 'recovered' } })
  })

  it('delivers its exact completion when another full identity advances the phone projection', async () => {
    await read('identities', 'active')
    await vi.advanceTimersByTimeAsync(60_000)
    const provider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockReturnValueOnce(provider.promise)
    const waiting = read('identities')
    await vi.advanceTimersByTimeAsync(0)
    fixture.title = 'other head'
    await read('identities', 'active', 'head-b')
    fixture.title = 'original exact completion'
    provider.resolve(found())
    await vi.advanceTimersByTimeAsync(0)
    expect(await waiting).toMatchObject({
      kind: 'found',
      pr: { title: 'original exact completion' }
    })
  })

  it('shares overlapping fresh discovery across clients without joining older timed work', async () => {
    mocks.resolve.mockImplementation(async () => {
      // ast-grep-ignore: test-no-real-time-wait -- Fake-clock provider delay exercises host admission and completion.
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      return found()
    })
    const discoveries = Promise.all(
      Array.from({ length: 2 }, () =>
        Promise.all(Array.from({ length: 14 }, (_, row) => read(`discovery-${row}`, 'active')))
      )
    )
    await vi.advanceTimersByTimeAsync(1_000)
    await discoveries
    expect(mocks.resolve).toHaveBeenCalledTimes(14)
    await vi.advanceTimersByTimeAsync(60_000)
    const slow = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockReturnValueOnce(slow.promise)
    const timed = read('discovery-0')
    await vi.advanceTimersByTimeAsync(0)
    fixture.title = 'fresh action'
    const actions = Promise.all([read('discovery-0', 'active'), read('discovery-0', 'active')])
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await actions).toMatchObject([
      { pr: { title: 'fresh action' } },
      { pr: { title: 'fresh action' } }
    ])
    expect(mocks.resolve).toHaveBeenCalledTimes(16)
    fixture.title = 'obsolete timer'
    slow.resolve(found())
    await vi.advanceTimersByTimeAsync(0)
    expect(await timed).toMatchObject({ pr: { title: 'fresh action' } })
    expect(await read('discovery-0')).toMatchObject({ pr: { title: 'fresh action' } })
  })

  it.each([true, false])(
    'does not restore full content after a narrowed observation (warm=%s)',
    async (warm) => {
      if (warm) {
        await read('fenced', 'active')
        await vi.advanceTimersByTimeAsync(60_000)
      }
      const provider = Promise.withResolvers<PRRefreshOutcome>()
      mocks.resolve.mockReturnValueOnce(provider.promise)
      const timed = read('fenced')
      await vi.advanceTimersByTimeAsync(0)
      const joined = read('fenced')
      await vi.advanceTimersByTimeAsync(0)
      const { getPRForBranchOutcome, readRecentPhonePROutcome } =
        await import('../../../github/client/lookup/pr-for-branch-outcome')
      await getPRForBranchOutcome('/repo', 'fenced', null, null, null, {
        currentHeadOid: 'head-a',
        includeDerivedData: false
      })
      fixture.title = 'obsolete full content'
      provider.resolve(found())
      await vi.advanceTimersByTimeAsync(0)
      expect(await Promise.all([timed, joined])).toEqual([
        { revalidation: { invalidated: true, retryAfterMs: 10_000 } },
        { revalidation: { invalidated: true, retryAfterMs: 10_000 } }
      ])
      expect(mocks.resolve).toHaveBeenCalledTimes(warm ? 3 : 2)
      expect(
        await readRecentPhonePROutcome('/repo', 'fenced', null, null, null, {
          currentHeadOid: 'head-a'
        })
      ).toBeNull()
      fixture.title = 'new foreground observation'
      expect(await read('fenced', 'active')).toMatchObject({
        pr: { title: 'new foreground observation' }
      })
    }
  )

  it('delivers a retained cold no-PR completion to both timed consumers', async () => {
    const provider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockReturnValueOnce(provider.promise)
    const cold = read('cold-absence')
    await vi.advanceTimersByTimeAsync(0)
    const joined = read('cold-absence')
    await vi.advanceTimersByTimeAsync(0)
    provider.resolve({ kind: 'no-pr', fetchedAt: 1_000 })
    expect(await Promise.all([cold, joined])).toEqual([
      { kind: 'no-pr', fetchedAt: 1_000 },
      { kind: 'no-pr', fetchedAt: 1_000 }
    ])
  })

  registerPRProducerSettlementTests({ read, mocks, found })

  it('delivers the current result to cold timers and their pending joiners after a fresh successor', async () => {
    const provider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockReturnValueOnce(provider.promise)
    const cold = read('cold-successor')
    await vi.advanceTimersByTimeAsync(0)
    const joined = read('cold-successor')
    await vi.advanceTimersByTimeAsync(0)
    fixture.title = 'authoritative foreground'
    await read('cold-successor', 'active')
    fixture.title = 'superseded cold content'
    provider.resolve(found())
    await vi.advanceTimersByTimeAsync(0)
    expect(await Promise.all([cold, joined])).toMatchObject([
      { kind: 'found', pr: { title: 'authoritative foreground' } },
      { kind: 'found', pr: { title: 'authoritative foreground' } }
    ])
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })

  it('gives a superseded timer a short retry until another client fresh read completes', async () => {
    await read('successor', 'active')
    await vi.advanceTimersByTimeAsync(60_000)
    const timedProvider = Promise.withResolvers<PRRefreshOutcome>()
    const freshProvider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve
      .mockReturnValueOnce(timedProvider.promise)
      .mockReturnValueOnce(freshProvider.promise)
    const timed = read('successor')
    await vi.advanceTimersByTimeAsync(0)
    const fresh = read('successor', 'active')
    await vi.advanceTimersByTimeAsync(0)
    fixture.title = 'superseded timer'
    timedProvider.resolve(found())
    await vi.advanceTimersByTimeAsync(0)
    expect(await timed).toMatchObject({
      kind: 'found',
      pr: { title: 'before' },
      fetchedAt: 1_000,
      revalidation: { retryAfterMs: 10_000 }
    })
    fixture.title = 'another client fresh result'
    freshProvider.resolve(found())
    await fresh
    const starts = mocks.resolve.mock.calls.length
    expect(await read('successor')).toMatchObject({ pr: { title: 'another client fresh result' } })
    expect(mocks.resolve).toHaveBeenCalledTimes(starts)
  })

  it('retains an in-flight timer failure when a new branch fills the exact-result cache', async () => {
    for (let branch = 0; branch < 256; branch += 1) {
      await read(`capacity-${branch}`, 'active')
    }
    await vi.advanceTimersByTimeAsync(60_000)
    const provider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockReturnValueOnce(provider.promise)
    const waiting = read('capacity-0')
    await vi.advanceTimersByTimeAsync(25_000)
    expect(await waiting).toMatchObject({ revalidation: { retryAfterMs: 10_000 } })
    await read('capacity-new', 'active')
    provider.resolve({
      kind: 'upstream-error',
      errorType: 'network',
      message: 'retained late failure',
      fetchedAt: Date.now()
    })
    await vi.advanceTimersByTimeAsync(0)
    const starts = mocks.resolve.mock.calls.length
    expect(await read('capacity-0')).toMatchObject({
      kind: 'upstream-error',
      message: 'retained late failure',
      nextAutoRetryAt: expect.any(Number)
    })
    expect(mocks.resolve).toHaveBeenCalledTimes(starts)
    const error = await read('capacity-0')
    if (!('kind' in error) || error.kind !== 'upstream-error') {
      throw new Error('expected the retained capacity failure')
    }
    await vi.advanceTimersByTimeAsync(error.nextAutoRetryAt! - Date.now())
    const pausedUntil = Date.now() + 60_000
    mocks.gate.mockResolvedValue(pausedUntil)
    const gated = read('capacity-0')
    await vi.advanceTimersByTimeAsync(25_000)
    expect(await gated).toMatchObject({ kind: 'upstream-error', message: 'retained late failure' })
    expect(mocks.resolve).toHaveBeenCalledTimes(starts)
    fixture.title = 'capacity recovery'
    mocks.gate.mockResolvedValue(null)
    await vi.advanceTimersByTimeAsync(35_000)
    expect(await read('capacity-0')).toMatchObject({
      kind: 'found',
      pr: { title: 'capacity recovery' }
    })
  })

  it('keeps unrelated timer data after many branch watches invalidate their own content', async () => {
    const { getPRForBranchOutcome } =
      await import('../../../github/client/lookup/pr-for-branch-outcome')
    const watch = (branch: string) =>
      getPRForBranchOutcome('/repo', branch, null, null, null, {
        currentHeadOid: 'head-a',
        includeDerivedData: false
      })
    for (let branch = 0; branch < 256; branch += 1) {
      await watch(`watch-${branch}`)
    }
    await read('unrelated', 'active')
    await watch('watch-0')
    await watch('watch-256')
    fixture.title = 'should wait for its own refresh'
    const starts = mocks.resolve.mock.calls.length
    expect(await read('unrelated')).toMatchObject({
      kind: 'found',
      pr: { title: 'before' },
      fetchedAt: 1_000
    })
    expect(mocks.resolve).toHaveBeenCalledTimes(starts)
  })

  it('refuses extra automatic retention while protected reads fill capacity but leaves foreground usable', async () => {
    const provider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockReturnValue(provider.promise)
    const foreground = Array.from({ length: 256 }, (_, branch) =>
      read(`protected-${branch}`, 'active')
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(await read('excess')).toEqual({
      revalidation: { invalidated: true, retryAfterMs: 10_000 }
    })
    expect(mocks.resolve).toHaveBeenCalledTimes(256)
    mocks.resolve.mockImplementation(async () => found())
    fixture.title = 'foreground still available'
    expect(await read('excess', 'active')).toMatchObject({
      pr: { title: 'foreground still available' }
    })
    provider.resolve(found())
    await Promise.all(foreground)
    expect(await read('excess')).toMatchObject({ kind: 'found' })
  })

  it.each(['runtime', 'local'] as const)(
    'observes one provider read when %s starts the local/runtime overlap',
    async (first) => {
      const { addPRRefreshOutcomeObserver, enqueuePRRefresh } =
        await import('../../../github/pull-requests/refresh/pr-refresh-coordinator')
      const { setPRRefreshRendererPort } =
        await import('../../../github/pull-requests/refresh/pr-refresh-renderer-port')
      const observe = vi.fn()
      const broadcast = vi.fn()
      const remove = addPRRefreshOutcomeObserver(observe)
      setPRRefreshRendererPort({ isRendererOpen: () => true, sendToTrustedUI: broadcast })
      const provider = Promise.withResolvers<PRRefreshOutcome>()
      mocks.resolve.mockReturnValue(provider.promise)
      const local = () =>
        enqueuePRRefresh(
          makeCandidate({
            cacheKey: '/repo::observed',
            repoId: 'repo',
            branch: 'observed',
            currentHeadOid: 'head-a'
          }),
          'active'
        )
      try {
        let runtime: ReturnType<typeof read>
        if (first === 'runtime') {
          runtime = read('observed', 'active')
          await vi.advanceTimersByTimeAsync(0)
          local()
          await vi.advanceTimersByTimeAsync(0)
        } else {
          local()
          await vi.advanceTimersByTimeAsync(0)
          runtime = read('observed', 'active')
          await vi.advanceTimersByTimeAsync(0)
        }
        fixture.title = 'shared observable result'
        provider.resolve(found())
        expect(await runtime).toMatchObject({ pr: { title: 'shared observable result' } })
        await vi.advanceTimersByTimeAsync(0)
        expect(mocks.resolve).toHaveBeenCalledTimes(1)
        expect(observe).toHaveBeenCalledTimes(1)
        expect(broadcast).toHaveBeenCalledWith(
          'gh:prRefreshEvent',
          expect.objectContaining({
            aliases: expect.arrayContaining([
              expect.objectContaining({ cacheKey: '/repo::observed' })
            ]),
            outcome: expect.objectContaining({
              kind: 'found',
              pr: expect.objectContaining({ title: 'shared observable result' })
            })
          })
        )
      } finally {
        remove()
        setPRRefreshRendererPort(null)
      }
    }
  )

  it('returns legacy timed cache immediately and never sends a receipt-only reply', async () => {
    await read('legacy', 'active')
    await vi.advanceTimersByTimeAsync(60_000)
    const provider = Promise.withResolvers<PRRefreshOutcome>()
    mocks.resolve.mockReturnValueOnce(provider.promise)
    const legacy = await commands.getRepoPRForBranch(
      'repo',
      'legacy',
      null,
      null,
      false,
      'head-a',
      'swr'
    )
    expect(legacy).toMatchObject({ kind: 'found', fetchedAt: 1_000 })
    provider.resolve(found())
    await vi.advanceTimersByTimeAsync(0)
  })
})
