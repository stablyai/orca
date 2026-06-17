import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { buildWorktreeSetLinkParams, fetchWorktreeLinkedPR } from './mobile-pr-link'

describe('buildWorktreeSetLinkParams', () => {
  it('sets linkedPR to a number when linking', () => {
    expect(buildWorktreeSetLinkParams('repo42::/p', 12)).toEqual({
      worktree: 'id:repo42::/p',
      linkedPR: 12
    })
  })

  it('sets linkedPR to null when unlinking', () => {
    expect(buildWorktreeSetLinkParams('repo42::/p', null)).toEqual({
      worktree: 'id:repo42::/p',
      linkedPR: null
    })
  })
})

describe('fetchWorktreeLinkedPR', () => {
  const client = (result: unknown, okFlag = true) =>
    ({
      sendRequest: vi.fn(async () =>
        okFlag ? { ok: true, result } : { ok: false, error: { message: 'x' } }
      )
    }) as unknown as Pick<RpcClient, 'sendRequest'>

  it('returns the linkedPR number when present', async () => {
    expect(await fetchWorktreeLinkedPR(client({ worktree: { linkedPR: 12 } }), 'w')).toBe(12)
  })

  it('returns null when unset, null, or non-numeric', async () => {
    expect(await fetchWorktreeLinkedPR(client({ worktree: {} }), 'w')).toBeNull()
    expect(await fetchWorktreeLinkedPR(client({ worktree: { linkedPR: null } }), 'w')).toBeNull()
    expect(await fetchWorktreeLinkedPR(client({ worktree: { linkedPR: 'x' } }), 'w')).toBeNull()
  })

  it('returns null when the request fails', async () => {
    expect(await fetchWorktreeLinkedPR(client(null, false), 'w')).toBeNull()
  })
})
