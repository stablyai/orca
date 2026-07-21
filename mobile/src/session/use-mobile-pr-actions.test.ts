import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import { PrActionsEngine, type PrActionMutations } from './pr-actions-engine'
import {
  fetchMergePR,
  fetchRemovePRReviewers,
  fetchRequestPRReviewers,
  fetchRerunPRChecks,
  fetchUpdatePRState
} from './github-pr-mutations'

const WORKTREE_ID = 'repo-42::/path/to/wt'
const ENTERPRISE_PR_REPO = { owner: 'fork', repo: 'proj', host: 'github.acme.test' }

function okStatus(): RpcResponse {
  return { id: 'x', ok: true, result: { ok: true }, _meta: { runtimeId: 'r' } }
}

function failStatus(error: string): RpcResponse {
  return { id: 'x', ok: true, result: { ok: false, error }, _meta: { runtimeId: 'r' } }
}

function mockClient(response: RpcResponse) {
  const sendRequest = vi.fn(async (_method: string, _params?: unknown) => response)
  return { client: { sendRequest }, sendRequest }
}

// A controllable deferred so a test can resolve responses out of order.
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function fakeMutations(overrides: Partial<PrActionMutations> = {}): PrActionMutations {
  const ok = async () => ({ ok: true as const })
  return {
    mergePR: vi.fn(ok),
    setPRAutoMerge: vi.fn(ok),
    updatePRState: vi.fn(ok),
    requestReviewers: vi.fn(ok),
    removeReviewers: vi.fn(ok),
    rerunChecks: vi.fn(ok),
    ...overrides
  }
}

function makeEngine(
  mutations: PrActionMutations,
  refetch = vi.fn(async () => {}),
  prRepo: typeof ENTERPRISE_PR_REPO | null = null
) {
  const onChange = vi.fn()
  const engine = new PrActionsEngine({
    mutations,
    prNumber: 7,
    headSha: 'abc123',
    prRepo,
    refetch,
    onChange
  })
  return { engine, onChange, refetch }
}

// ─── mutation wrappers: prRepo / param shapes ───────────────────────────────

describe('mutation wrappers — prRepo + param shapes', () => {
  it('mergePR carries method + prRepo (fork) and uses the id: repo selector', async () => {
    const { client, sendRequest } = mockClient(okStatus())
    await fetchMergePR(client, WORKTREE_ID, {
      prNumber: 7,
      method: 'squash',
      prRepo: ENTERPRISE_PR_REPO
    })
    expect(sendRequest).toHaveBeenCalledWith(
      'github.mergePR',
      expect.objectContaining({
        repo: 'id:repo-42',
        prNumber: 7,
        method: 'squash',
        prRepo: ENTERPRISE_PR_REPO
      })
    )
  })

  it('updatePRState carries the host-qualified PR repo and state update', async () => {
    const { client, sendRequest } = mockClient(okStatus())
    await fetchUpdatePRState(client, WORKTREE_ID, {
      prNumber: 7,
      state: 'closed',
      prRepo: ENTERPRISE_PR_REPO
    })
    const [, params] = sendRequest.mock.calls[0]
    expect(params).toEqual({
      repo: 'id:repo-42',
      prNumber: 7,
      updates: { state: 'closed' },
      prRepo: ENTERPRISE_PR_REPO
    })
  })

  it('updatePRState reopen passes state:open', async () => {
    const { client, sendRequest } = mockClient(okStatus())
    await fetchUpdatePRState(client, WORKTREE_ID, { prNumber: 7, state: 'open' })
    const [, params] = sendRequest.mock.calls[0] as [string, Record<string, unknown>]
    expect((params.updates as { state: string }).state).toBe('open')
  })

  it('request/remove reviewers carry the host-qualified PR repo', async () => {
    const { client, sendRequest } = mockClient(okStatus())
    await fetchRequestPRReviewers(client, WORKTREE_ID, {
      prNumber: 7,
      reviewers: ['alice'],
      prRepo: ENTERPRISE_PR_REPO
    })
    await fetchRemovePRReviewers(client, WORKTREE_ID, {
      prNumber: 7,
      reviewers: ['bob'],
      prRepo: ENTERPRISE_PR_REPO
    })
    expect(sendRequest.mock.calls[0][1]).toMatchObject({
      reviewers: ['alice'],
      prRepo: ENTERPRISE_PR_REPO
    })
    expect(sendRequest.mock.calls[1][1]).toMatchObject({
      reviewers: ['bob'],
      prRepo: ENTERPRISE_PR_REPO
    })
  })

  it('rerunPRChecks carries failedOnly, headSha, and the host-qualified PR repo', async () => {
    const { client, sendRequest } = mockClient(okStatus())
    await fetchRerunPRChecks(client, WORKTREE_ID, {
      prNumber: 7,
      headSha: 'abc',
      failedOnly: true,
      prRepo: ENTERPRISE_PR_REPO
    })
    const [, params] = sendRequest.mock.calls[0]
    expect(params).toMatchObject({
      prNumber: 7,
      failedOnly: true,
      headSha: 'abc',
      prRepo: ENTERPRISE_PR_REPO
    })
  })

  it('a host { ok:false, error } result surfaces as a failure outcome', async () => {
    const { client } = mockClient(failStatus('merge blocked'))
    const outcome = await fetchMergePR(client, WORKTREE_ID, { prNumber: 7 })
    expect(outcome).toEqual({ ok: false, error: 'merge blocked' })
  })
})

// ─── engine: merge / state / reviewers / rerun ──────────────────────────────

describe('PrActionsEngine — merge', () => {
  it('merge fires with the chosen method and refetches on success', async () => {
    const mutations = fakeMutations()
    const { engine, refetch } = makeEngine(mutations)
    await engine.merge('rebase')
    expect(mutations.mergePR).toHaveBeenCalledWith({ prNumber: 7, method: 'rebase', prRepo: null })
    expect(refetch).toHaveBeenCalledOnce()
    expect(engine.error).toBeNull()
    expect(engine.busy).toBeNull()
  })

  it('transient merge failure sets a non-blocking error and no refetch', async () => {
    const mutations = fakeMutations({
      mergePR: vi.fn(async () => ({ ok: false as const, error: 'network timeout' }))
    })
    const { engine, refetch } = makeEngine(mutations)
    await engine.merge('squash')
    expect(engine.error).toBe('network timeout')
    expect(engine.blocked).toBeNull()
    expect(refetch).not.toHaveBeenCalled()
  })
})

describe('PrActionsEngine — auto-merge optimistic revert', () => {
  it('reverts the optimistic toggle on transient failure', async () => {
    const mutations = fakeMutations({
      setPRAutoMerge: vi.fn(async () => ({ ok: false as const, error: 'connection lost' }))
    })
    const { engine } = makeEngine(mutations, undefined, ENTERPRISE_PR_REPO)
    // authoritative = false; user enables.
    await engine.setAutoMerge(true, 'squash')
    expect(mutations.setPRAutoMerge).toHaveBeenCalledWith({
      prNumber: 7,
      enabled: true,
      method: 'squash',
      prRepo: ENTERPRISE_PR_REPO
    })
    // Reverted to authoritative after transient failure.
    expect(engine.resolveAutoMerge(false)).toBe(false)
    expect(engine.error).toBe('connection lost')
  })

  it('keeps the optimistic value through success until refetch', async () => {
    const mutations = fakeMutations()
    const { engine, refetch } = makeEngine(mutations)
    await engine.setAutoMerge(true)
    // After success the optimism clears to authoritative (refetch supplies truth).
    expect(engine.resolveAutoMerge(true)).toBe(true)
    expect(refetch).toHaveBeenCalledOnce()
  })
})

describe('PrActionsEngine — updateState close/reopen', () => {
  it('close fires state:closed and reopen fires state:open', async () => {
    const mutations = fakeMutations()
    const { engine } = makeEngine(mutations, undefined, ENTERPRISE_PR_REPO)
    await engine.updateState('closed')
    await engine.updateState('open')
    expect(mutations.updatePRState).toHaveBeenNthCalledWith(1, {
      prNumber: 7,
      state: 'closed',
      prRepo: ENTERPRISE_PR_REPO
    })
    expect(mutations.updatePRState).toHaveBeenNthCalledWith(2, {
      prNumber: 7,
      state: 'open',
      prRepo: ENTERPRISE_PR_REPO
    })
  })
})

describe('PrActionsEngine — reviewers', () => {
  it('requestReviewer adds via requestReviewers with a host-qualified PR repo', async () => {
    const mutations = fakeMutations()
    const { engine } = makeEngine(mutations, undefined, ENTERPRISE_PR_REPO)
    await engine.requestReviewer('alice')
    expect(mutations.requestReviewers).toHaveBeenCalledWith({
      prNumber: 7,
      reviewers: ['alice'],
      prRepo: ENTERPRISE_PR_REPO
    })
  })

  it('removeReviewer optimistic revert on transient failure', async () => {
    const mutations = fakeMutations({
      removeReviewers: vi.fn(async () => ({ ok: false as const, error: 'temporary error' }))
    })
    const { engine } = makeEngine(mutations)
    // authoritative requested = true; user removes.
    await engine.removeReviewer('bob')
    expect(engine.resolveReviewerRequested('bob', true)).toBe(true) // reverted
    expect(engine.error).toBe('temporary error')
  })
})

describe('PrActionsEngine — rerun checks', () => {
  it('fires failedOnly:true with headSha and refetches on success', async () => {
    const mutations = fakeMutations()
    const { engine, refetch } = makeEngine(mutations, undefined, ENTERPRISE_PR_REPO)
    await engine.rerunFailingChecks()
    expect(mutations.rerunChecks).toHaveBeenCalledWith({
      prNumber: 7,
      headSha: 'abc123',
      failedOnly: true,
      prRepo: ENTERPRISE_PR_REPO
    })
    expect(refetch).toHaveBeenCalledOnce()
  })
})

// ─── permanent vs transient + last-intent-wins ──────────────────────────────

describe('PrActionsEngine — permanent failure (403)', () => {
  it('routes a permission denial to blocked, clears optimism, no auto-retry/refetch', async () => {
    const mutations = fakeMutations({
      setPRAutoMerge: vi.fn(async () => ({ ok: false as const, error: 'HTTP 403: forbidden' }))
    })
    const { engine, refetch } = makeEngine(mutations)
    await engine.setAutoMerge(true)
    expect(engine.blocked).toBe('HTTP 403: forbidden')
    expect(engine.error).toBeNull()
    expect(engine.resolveAutoMerge(false)).toBe(false) // optimism cleared to authoritative
    expect(refetch).not.toHaveBeenCalled()
    // mutation fired exactly once — never auto-retried.
    expect(mutations.setPRAutoMerge).toHaveBeenCalledOnce()
  })
})

describe('PrActionsEngine — last-intent-wins under out-of-order responses', () => {
  it('A resolving after B does not overwrite B (B is latest)', async () => {
    const dA = deferred<{ ok: true } | { ok: false; error: string }>()
    const dB = deferred<{ ok: true } | { ok: false; error: string }>()
    let call = 0
    const mutations = fakeMutations({
      setPRAutoMerge: vi.fn(async () => {
        call += 1
        return call === 1 ? dA.promise : dB.promise
      })
    })
    const { engine } = makeEngine(mutations)
    // authoritative = false
    const pA = engine.setAutoMerge(true) // intent A: enable
    const pB = engine.setAutoMerge(false) // intent B: disable (latest)
    expect(engine.resolveAutoMerge(false)).toBe(false) // shows B's optimistic value

    // A resolves LATE (success) — must not flip back to A's intent.
    dA.resolve({ ok: true })
    await pA
    expect(engine.resolveAutoMerge(false)).toBe(false)

    // B resolves and is latest → clears optimism to authoritative.
    dB.resolve({ ok: true })
    await pB
    expect(engine.resolveAutoMerge(false)).toBe(false)
  })
})

describe('PrActionsEngine — busy targeting', () => {
  it('busy targets only the firing row and clears afterward', async () => {
    const d = deferred<{ ok: true }>()
    const mutations = fakeMutations({
      requestReviewers: vi.fn(async () => d.promise)
    })
    const { engine } = makeEngine(mutations)
    const p = engine.requestReviewer('alice')
    expect(engine.isBusy({ kind: 'reviewer', login: 'alice' })).toBe(true)
    expect(engine.isBusy({ kind: 'reviewer', login: 'bob' })).toBe(false)
    expect(engine.isBusy({ kind: 'merge' })).toBe(false)
    d.resolve({ ok: true })
    await p
    expect(engine.busy).toBeNull()
  })
})
