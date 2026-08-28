import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../db'
import { ControlPlaneStore } from './control-plane-store'
import {
  acquireValidationLease,
  assertMutationAllowed,
  DEFAULT_VALIDATION_LEASE_TTL_MS,
  releaseValidationLease
} from './validation-lease'

const NOW = Date.parse('2026-08-27T12:00:00.000Z')

describe('B9 validation lease protects an in-flight gate', () => {
  let db: OrchestrationDb
  afterEach(() => db?.close())

  function store(): ControlPlaneStore {
    db = new OrchestrationDb(':memory:')
    return new ControlPlaneStore(db)
  }

  function acquire(cp: ControlPlaneStore, overrides: Record<string, unknown> = {}) {
    return acquireValidationLease(cp, {
      scopeKey: 'wt_1',
      leaseId: 'lease_1',
      owner: 'ctx_1',
      idempotencyKey: 'idem_1',
      nowMs: NOW,
      ...overrides
    })
  }

  it('blocks a source mutation while the lease is active', () => {
    const cp = store()
    expect(acquire(cp)).toMatchObject({ ok: true, duplicate: false })
    const guard = assertMutationAllowed(cp, { scopeKey: 'wt_1', nowMs: NOW + 1000 })
    expect(guard).toMatchObject({ allowed: false, code: 'validation_in_progress' })
    expect(guard.allowed === false && guard.remedies).toEqual([
      'wait_for_lease_completion',
      'use_separate_worktree'
    ])
  })

  it('negative control: with no lease the same mutation is allowed', () => {
    const cp = store()
    expect(assertMutationAllowed(cp, { scopeKey: 'wt_1', nowMs: NOW })).toEqual({ allowed: true })
  })

  it('NEGATIVE CONTROL: the lease HOLDER is blocked too', () => {
    // Reversed deliberately. Owning a lease is authority to release it, never
    // authority to mutate under it: the holder is exactly the Dispatch whose
    // gate child process is reading the tree right now, so its own edits are
    // the contamination the lease exists to prevent.
    const cp = store()
    acquire(cp)
    expect(assertMutationAllowed(cp, { scopeKey: 'wt_1', nowMs: NOW })).toMatchObject({
      allowed: false,
      code: 'validation_in_progress'
    })
  })

  it('refuses a second owner while the first lease is live', () => {
    const cp = store()
    acquire(cp)
    expect(
      acquire(cp, { leaseId: 'lease_2', owner: 'ctx_2', idempotencyKey: 'idem_2' })
    ).toMatchObject({ ok: false, code: 'held_by_other_owner' })
  })

  it('is idempotent for the SAME acquirer retrying', () => {
    const cp = store()
    acquire(cp)
    const retry = acquire(cp)
    expect(retry).toMatchObject({ ok: true, duplicate: true })
    expect(retry.ok && retry.lease.leaseId).toBe('lease_1')
  })

  it('NEGATIVE CONTROL: another owner reusing the idempotency key is refused', () => {
    // An idempotency key is caller-chosen, so matching on it alone handed a
    // DIFFERENT Dispatch the lease someone else was holding. A replay is the
    // same acquirer asking again, not anyone who guessed the key.
    const cp = store()
    acquire(cp)
    expect(acquire(cp, { owner: 'ctx_other', leaseId: 'lease_other' })).toMatchObject({
      ok: false,
      code: 'held_by_other_owner'
    })
    expect(cp.getValidationLease('wt_1')?.owner).toBe('ctx_1')
  })

  it('NEGATIVE CONTROL: the same owner naming a different lease id is refused', () => {
    const cp = store()
    acquire(cp)
    expect(acquire(cp, { leaseId: 'lease_retry' })).toMatchObject({
      ok: false,
      code: 'held_by_other_owner'
    })
  })

  it('reclaims a lease whose owner crashed once it expires', () => {
    const cp = store()
    acquire(cp)
    const afterExpiry = NOW + DEFAULT_VALIDATION_LEASE_TTL_MS + 1
    expect(assertMutationAllowed(cp, { scopeKey: 'wt_1', nowMs: afterExpiry })).toEqual({
      allowed: true
    })
    expect(
      acquire(cp, {
        leaseId: 'lease_2',
        owner: 'ctx_2',
        idempotencyKey: 'idem_2',
        nowMs: afterExpiry
      })
    ).toMatchObject({ ok: true, reclaimed: true })
  })

  it('frees the scope on release and makes a duplicate release a no-op', () => {
    const cp = store()
    acquire(cp)
    expect(
      releaseValidationLease(cp, {
        scopeKey: 'wt_1',
        leaseId: 'lease_1',
        nowMs: NOW + 5,
        owner: 'ctx_1'
      })
    ).toEqual({ released: true })
    expect(assertMutationAllowed(cp, { scopeKey: 'wt_1', nowMs: NOW + 6 })).toEqual({
      allowed: true
    })
    expect(
      releaseValidationLease(cp, {
        scopeKey: 'wt_1',
        leaseId: 'lease_1',
        nowMs: NOW + 7,
        owner: 'ctx_1'
      })
    ).toEqual({ released: false })
  })

  it('ignores a release from a lease id that does not own the scope', () => {
    const cp = store()
    acquire(cp)
    expect(
      releaseValidationLease(cp, {
        scopeKey: 'wt_1',
        leaseId: 'lease_other',
        nowMs: NOW + 5,
        owner: 'ctx_1'
      })
    ).toEqual({ released: false })
    expect(assertMutationAllowed(cp, { scopeKey: 'wt_1', nowMs: NOW + 6 }).allowed).toBe(false)
  })

  it('NEGATIVE CONTROL: a release naming no owner is refused', () => {
    // An optional owner meant a caller that simply omitted it could release
    // anyone's lease — the lease id travels in receipts and logs.
    const cp = store()
    acquire(cp)
    expect(
      releaseValidationLease(cp, {
        scopeKey: 'wt_1',
        leaseId: 'lease_1',
        nowMs: NOW + 5,
        owner: ''
      })
    ).toEqual({ released: false })
    expect(assertMutationAllowed(cp, { scopeKey: 'wt_1', nowMs: NOW + 6 }).allowed).toBe(false)
  })

  it('NEGATIVE CONTROL: a release from the wrong owner is refused', () => {
    const cp = store()
    acquire(cp)
    expect(
      releaseValidationLease(cp, {
        scopeKey: 'wt_1',
        leaseId: 'lease_1',
        nowMs: NOW + 5,
        owner: 'ctx_impostor'
      })
    ).toEqual({ released: false })
    expect(assertMutationAllowed(cp, { scopeKey: 'wt_1', nowMs: NOW + 6 }).allowed).toBe(false)
  })

  it('scopes leases per worktree, so a separate worktree stays writable', () => {
    const cp = store()
    acquire(cp)
    expect(assertMutationAllowed(cp, { scopeKey: 'wt_2', nowMs: NOW })).toEqual({ allowed: true })
  })
})
