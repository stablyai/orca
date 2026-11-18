import { describe, expect, it, vi } from 'vitest'
import { PrActionsEngine } from './pr-actions-engine'
import './pr-action-mutation-contract'
import type { PrActionMutations } from './pr-action-mutation-contract'
import type { GitHubPrMutationOutcome } from '../../github-operations/github-pr-mutation-outcome'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('PrActionsEngine — PR identity changes', () => {
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

describe('PrActionsEngine — merge', () => {
  it('fences the merge to the PR head on screen, not the worktree head', async () => {
    const mergePR = vi.fn(async () => ({ ok: true as const }))
    const fail = async () => ({ ok: false as const, error: 'unused' })
    const engine = new PrActionsEngine({
      mutations: {
        mergePR,
        setPRAutoMerge: fail,
        updatePRState: fail,
        markReadyForReview: fail,
        markDraft: fail,
        requestReviewers: fail,
        removeReviewers: fail,
        rerunChecks: fail
      },
      prNumber: 7,
      headSha: '1111111111111111111111111111111111111111',
      prHeadSha: '2222222222222222222222222222222222222222',
      refetch: vi.fn(),
      onChange: vi.fn()
    })

    await engine.merge('squash')

    expect(mergePR).toHaveBeenCalledWith({
      prNumber: 7,
      method: 'squash',
      prRepo: undefined,
      expectedHeadSha: '2222222222222222222222222222222222222222'
    })
  })
})
