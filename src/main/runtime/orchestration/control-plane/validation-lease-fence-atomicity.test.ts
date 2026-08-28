import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import { acquireValidationLease } from './validation-lease'

const SCOPE = 'wt:repo_a::/work/tree'

/** The database row and the durable offline marker have to become true together.
 *
 *  Committing the row first left a window in which a crash — or a failed write —
 *  produced an active lease with no marker, so a disconnected worker saw an
 *  unfenced workspace the database said was protected. The reverse order can
 *  only ever over-deny until the marker expires, which is the safe direction. */
describe('a lease and its offline fence commit together', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function store(): ControlPlaneStore {
    db = new OrchestrationDb(':memory:')
    return new ControlPlaneStore(db)
  }

  const base = {
    scopeKey: SCOPE,
    leaseId: 'lease_1',
    owner: 'ctx_owner',
    idempotencyKey: 'idem_1'
  }

  it('NEGATIVE CONTROL: a marker failure leaves NO active lease row behind', () => {
    const cp = store()
    expect(() =>
      acquireValidationLease(cp, {
        ...base,
        nowMs: Date.now(),
        establishFence: () => {
          throw new Error('no endpoint on this runtime')
        }
      })
    ).toThrow(/no endpoint/)
    // Rolled back with the marker: the caller is never told a tree is guarded
    // when the only offline fence for it does not exist.
    expect(cp.getValidationLease(SCOPE)).toBeUndefined()
  })

  it('NEGATIVE CONTROL: a crash between row and marker cannot leave a row', () => {
    const cp = store()
    // A throw from inside the callback is indistinguishable from the process
    // dying there, and both must end with nothing committed.
    expect(() =>
      acquireValidationLease(cp, {
        ...base,
        nowMs: Date.now(),
        establishFence: () => {
          throw Object.assign(new Error('killed'), { code: 'EIO' })
        }
      })
    ).toThrow()
    expect(cp.getValidationLease(SCOPE)).toBeUndefined()
  })

  it('commits the row only once the marker is established', () => {
    const cp = store()
    const seen: string[] = []
    const acquired = acquireValidationLease(cp, {
      ...base,
      nowMs: Date.now(),
      establishFence: (lease) => {
        // Still inside the transaction, so the row is not visible to anyone else.
        seen.push(lease.leaseId)
      }
    })
    expect(acquired.ok).toBe(true)
    expect(seen).toEqual(['lease_1'])
    expect(cp.getValidationLease(SCOPE)?.lease_id).toBe('lease_1')
  })

  it('NEGATIVE CONTROL: a retry whose marker refresh fails does NOT read as acquired', () => {
    const cp = store()
    const now = Date.now()
    expect(acquireValidationLease(cp, { ...base, nowMs: now, establishFence: () => {} }).ok).toBe(
      true
    )
    const retry = acquireValidationLease(cp, {
      ...base,
      nowMs: now + 10,
      establishFence: () => {
        throw new Error('marker write failed')
      }
    })
    // Two things have to be true at once. The retry is not certified — an
    // acquired PASS with no durable offline fence is the thing being prevented…
    expect(retry).toMatchObject({ ok: false, code: 'fence_refresh_failed' })
    expect(!retry.ok && retry.reason).toMatch(/marker write failed/)
    // …and the protection already in force is untouched, because tearing it down
    // over a retry's bookkeeping would unfence a tree mid-gate.
    expect(cp.getValidationLease(SCOPE)).toMatchObject({
      lease_id: 'lease_1',
      owner: 'ctx_owner',
      released_at: null
    })
  })

  it('a retry whose marker refresh succeeds is an ordinary idempotent duplicate', () => {
    const cp = store()
    const now = Date.now()
    acquireValidationLease(cp, { ...base, nowMs: now, establishFence: () => {} })
    expect(
      acquireValidationLease(cp, { ...base, nowMs: now + 10, establishFence: () => {} })
    ).toMatchObject({ ok: true, duplicate: true })
  })

  it('still refuses a second owner, and does not disturb the held lease', () => {
    const cp = store()
    const now = Date.now()
    acquireValidationLease(cp, { ...base, nowMs: now, establishFence: () => {} })
    const other = acquireValidationLease(cp, {
      ...base,
      owner: 'ctx_other',
      idempotencyKey: 'idem_other',
      nowMs: now + 10,
      establishFence: () => {
        throw new Error('should never be called for a refused acquire')
      }
    })
    expect(other).toMatchObject({ ok: false, code: 'held_by_other_owner' })
    expect(cp.getValidationLease(SCOPE)?.owner).toBe('ctx_owner')
  })
})
