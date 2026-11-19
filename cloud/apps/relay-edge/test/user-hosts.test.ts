// The erasure index object (UserHosts) and the host object's pending-write helpers.
import { describe, expect, it, vi } from 'vitest'
import { USER_INDEX_RETRY_MAX_MS, USER_INDEX_RETRY_MIN_MS, afterFailure, mergePending, userIndexOps } from '../src/user-index'
import { fakeObjectState } from './director-fixture'

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      readonly ctx: unknown,
      readonly env: unknown
    ) {}
  }
}))
const { UserHosts } = await import('../src/user-hosts')

const A = 'AAAAAAAAAAAAAAAA'
const B = 'BBBBBBBBBBBBBBBB'

function index() {
  const state = fakeObjectState()
  return { hosts: new UserHosts(state.ctx, {}), state }
}

describe('UserHosts', () => {
  it('add is idempotent: first seen stays, last seen moves forward only', async () => {
    const { hosts } = index()
    await hosts.add(A, 1_000)
    await hosts.add(A, 5_000)
    await hosts.add(A, 3_000)
    await hosts.add(B, 2_000)
    expect(await hosts.list()).toEqual([
      { relayHostId: A, firstSeen: 1_000, lastSeen: 5_000 },
      { relayHostId: B, firstSeen: 2_000, lastSeen: 2_000 }
    ])
  })

  it('remove drops one host, and again changes nothing', async () => {
    const { hosts } = index()
    await hosts.add(A, 1)
    await hosts.add(B, 1)
    await hosts.remove(A)
    await hosts.remove(A)
    expect((await hosts.list()).map((h) => h.relayHostId)).toEqual([B])
  })

  it('erase wipes every byte, and the index starts empty again', async () => {
    const { hosts, state } = index()
    await hosts.add(A, 1)
    await state.ctx.storage.put('adminJtis', { 'jti-0123456789abcdef': Date.now() + 60_000 })
    await hosts.erase()
    expect(state.tables()).toBe(0)
    expect(state.kv.size).toBe(0)
    expect(await hosts.list()).toEqual([])
  })
})

describe('pending index writes', () => {
  it('keeps the latest wanted state per user, due at once', () => {
    const first = mergePending(undefined, A, { u1: 'add' }, 10)
    const failed = afterFailure(first, first.ops, 20)
    const merged = mergePending(failed, A, userIndexOps('u2', 'u1'), 30)
    expect(merged).toEqual({ relayHostId: A, ops: { u1: 'remove', u2: 'add' }, attempts: 0, retryAt: 30 })
    expect(mergePending(merged, A, userIndexOps('u1', 'u2'), 40).ops).toEqual({ u1: 'add', u2: 'remove' })
  })

  it('backs off from the minimum to a cap', () => {
    let pending = mergePending(undefined, A, { u1: 'add' }, 0)
    const delays: number[] = []
    for (let i = 0; i < 10; i++) {
      pending = afterFailure(pending, pending.ops, 0)
      delays.push(pending.retryAt)
    }
    expect(delays[1]).toBe(2 * USER_INDEX_RETRY_MIN_MS)
    expect(delays.at(-1)).toBe(USER_INDEX_RETRY_MAX_MS)
    expect(pending.attempts).toBe(10)
  })
})
