import { describe, expect, it, vi } from 'vitest'
import { PrActionsEngine } from './pr-actions-engine'
import './pr-action-mutation-contract'
import type { PrActionMutations } from './pr-action-mutation-contract'
import type { GitHubPrMutationOutcome } from './github-pr-mutation-outcome'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('PrActionsEngine — PR identity changes', () => {
  it('clears reviewer optimism when switching PR identity', async () => {
    const slow = deferred<GitHubPrMutationOutcome>()
    const mutations: PrActionMutations = {
      mergePR: async () => ({ ok: true }),
      setPRAutoMerge: async () => ({ ok: true }),
      updatePRState: async () => ({ ok: true }),
      markReadyForReview: async () => ({ ok: true }),
      markDraft: async () => ({ ok: true }),
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

    slow.resolve({ ok: false, error: 'connection lost' })
    await action
    expect(engine.error).toBeNull()
    expect(refetch).not.toHaveBeenCalled()
  })

  it('clears in-flight state when only the GitHub host changes', async () => {
    const slow = deferred<GitHubPrMutationOutcome>()
    const mutations: PrActionMutations = {
      mergePR: async () => ({ ok: true }),
      setPRAutoMerge: async () => slow.promise,
      updatePRState: async () => ({ ok: true }),
      markReadyForReview: async () => ({ ok: true }),
      markDraft: async () => ({ ok: true }),
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
