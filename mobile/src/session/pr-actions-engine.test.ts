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
    const newer = deferred<GitHubPrMutationOutcome>()
    const engine = makeEngine({
      mergePR: () => slow.promise,
      updatePRState: () => newer.promise
    })

    const mergePromise = engine.merge()
    expect(engine.isBusy({ kind: 'merge' })).toBe(true)

    const statePromise = engine.updateState('closed')
    expect(engine.isBusy({ kind: 'state' })).toBe(true)

    // Late merge completion must not clear a newer action’s busy state.
    slow.resolve({ ok: true })
    await mergePromise
    expect(engine.isBusy({ kind: 'state' })).toBe(true)

    newer.resolve({ ok: true })
    await statePromise
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

  it('surfaces a refetch throw as error without rejecting the action promise', async () => {
    const engine = new PrActionsEngine({
      mutations: {
        mergePR: async () => ({ ok: true }),
        setPRAutoMerge: async () => ({ ok: true }),
        updatePRState: async () => ({ ok: true }),
        requestReviewers: async () => ({ ok: true }),
        removeReviewers: async () => ({ ok: true }),
        rerunChecks: async () => ({ ok: true })
      },
      prNumber: 1,
      refetch: async () => {
        throw new Error('refresh failed')
      },
      onChange: () => {}
    })
    await expect(engine.merge()).resolves.toBeUndefined()
    expect(engine.error).toBe('refresh failed')
    expect(engine.busy).toBeNull()
  })

  it('does not notify on no-op setError(null) at action start', async () => {
    const onChange = vi.fn()
    const engine = new PrActionsEngine({
      mutations: {
        mergePR: async () => ({ ok: true }),
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
    // Already-clear error state must not add a redundant action-start notification.
    onChange.mockClear()
    const p = engine.merge()
    expect(onChange).toHaveBeenCalledTimes(1)
    await p
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

  it('clears in-flight state when only the GitHub host changes', async () => {
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
    const baseConfig = {
      mutations,
      prNumber: 1,
      refetch,
      onChange
    }
    const engine = new PrActionsEngine({
      ...baseConfig,
      prRepo: { owner: 'acme', repo: 'widgets' }
    })

    const action = engine.setAutoMerge(true)
    expect(engine.resolveAutoMerge(false)).toBe(true)
    expect(engine.isBusy({ kind: 'autoMerge' })).toBe(true)

    engine.updateConfig({
      ...baseConfig,
      prRepo: { owner: 'acme', repo: 'widgets', host: 'github.acme.test' }
    })
    expect(engine.resolveAutoMerge(false)).toBe(false)
    expect(engine.busy).toBeNull()

    slow.resolve({ ok: true })
    await action
    expect(refetch).not.toHaveBeenCalled()
  })
})
