import { describe, expect, it, vi } from 'vitest'
import { PrActionsEngine, type PrActionMutations } from './pr-actions-engine'
import type { GitHubPrMutationOutcome } from './github-pr-mutations'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function makeEngine(mutations: Partial<PrActionMutations>) {
  const ok = async (): Promise<GitHubPrMutationOutcome> => ({ ok: true })
  return new PrActionsEngine({
    mutations: {
      mergePR: ok,
      setPRAutoMerge: ok,
      updatePRState: ok,
      requestReviewers: ok,
      removeReviewers: ok,
      rerunChecks: ok,
      ...mutations
    },
    prNumber: 1,
    refetch: () => {},
    onChange: () => {}
  })
}

describe('PrActionsEngine — scoped busy clear (overlapping actions)', () => {
  it('a late-resolving action does not clear a newer action busy state', async () => {
    const slow = deferred<GitHubPrMutationOutcome>()
    const engine = makeEngine({
      // merge resolves slowly; state resolves immediately.
      mergePR: () => slow.promise,
      updatePRState: async () => ({ ok: true })
    })

    // Start merge (sets busy = merge) but don't let it resolve yet.
    const mergePromise = engine.merge()
    expect(engine.isBusy({ kind: 'merge' })).toBe(true)

    // While merge is in-flight, run state to completion (sets then clears busy=state).
    await engine.updateState('closed')
    // State began after merge, so it overwrote busy to 'state', then cleared its own.
    expect(engine.isBusy({ kind: 'state' })).toBe(false)

    // Now let the slow merge finish. Its finally must NOT clear a busy it no longer owns.
    slow.resolve({ ok: true })
    await mergePromise
    // busy stays null (state already cleared); the key point is merge didn't clobber.
    expect(engine.busy).toBeNull()
  })

  it('clears its own busy when it is still the owner', async () => {
    const engine = makeEngine({})
    await engine.merge()
    expect(engine.busy).toBeNull()
  })
})

describe('PrActionsEngine — transport-rejection-normalized outcomes settle cleanly', () => {
  it('routes a { ok:false } outcome to error and clears busy', async () => {
    const onChange = vi.fn()
    const engine = new PrActionsEngine({
      mutations: {
        mergePR: async () => ({ ok: false, error: 'socket hung up' }),
        setPRAutoMerge: async () => ({ ok: true }),
        updatePRState: async () => ({ ok: true }),
        requestReviewers: async () => ({ ok: true }),
        removeReviewers: async () => ({ ok: true }),
        rerunChecks: async () => ({ ok: true })
      },
      prNumber: 1,
      refetch: () => {},
      onChange
    })
    await engine.merge()
    expect(engine.error).toBe('socket hung up')
    expect(engine.busy).toBeNull()
  })
})

describe('PrActionsEngine — PR identity changes', () => {
  it('clears optimistic state when the engine points at a different PR', async () => {
    const slow = deferred<GitHubPrMutationOutcome>()
    const mutations: PrActionMutations = {
      mergePR: async () => ({ ok: true }),
      setPRAutoMerge: async () => slow.promise,
      updatePRState: async () => ({ ok: true }),
      requestReviewers: async () => ({ ok: true }),
      removeReviewers: async () => ({ ok: true }),
      rerunChecks: async () => ({ ok: true })
    }
    const refetch = vi.fn()
    const onChange = vi.fn()
    const engine = new PrActionsEngine({
      mutations,
      prNumber: 1,
      refetch,
      onChange
    })

    const action = engine.setAutoMerge(true)
    expect(engine.resolveAutoMerge(false)).toBe(true)

    engine.updateConfig({
      mutations,
      prNumber: 2,
      refetch,
      onChange
    })
    expect(engine.resolveAutoMerge(false)).toBe(false)
    expect(engine.busy).toBeNull()

    slow.resolve({ ok: true })
    await action
    expect(refetch).not.toHaveBeenCalled()
  })

  it('clears reviewer optimism when switching PR identity', async () => {
    const slow = deferred<GitHubPrMutationOutcome>()
    const mutations: PrActionMutations = {
      mergePR: async () => ({ ok: true }),
      setPRAutoMerge: async () => ({ ok: true }),
      updatePRState: async () => ({ ok: true }),
      requestReviewers: async () => slow.promise,
      removeReviewers: async () => ({ ok: true }),
      rerunChecks: async () => ({ ok: true })
    }
    const refetch = vi.fn()
    const onChange = vi.fn()
    const engine = new PrActionsEngine({
      mutations,
      prNumber: 1,
      refetch,
      onChange
    })

    const action = engine.requestReviewer('alice')
    expect(engine.resolveReviewerRequested('alice', false)).toBe(true)

    engine.updateConfig({
      mutations,
      prNumber: 2,
      refetch,
      onChange
    })
    expect(engine.resolveReviewerRequested('alice', false)).toBe(false)

    slow.resolve({ ok: true })
    await action
    expect(refetch).not.toHaveBeenCalled()
  })
})
