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

  it('lets the lease holder itself keep working in the scope it owns', () => {
    const cp = store()
    acquire(cp)
    expect(
      assertMutationAllowed(cp, { scopeKey: 'wt_1', nowMs: NOW, holderLeaseId: 'lease_1' })
    ).toEqual({ allowed: true })
  })

  it('refuses a second owner while the first lease is live', () => {
    const cp = store()
    acquire(cp)
    expect(
      acquire(cp, { leaseId: 'lease_2', owner: 'ctx_2', idempotencyKey: 'idem_2' })
    ).toMatchObject({ ok: false, code: 'held_by_other_owner' })
  })

  it('is idempotent for a retried acquire with the same idempotency key', () => {
    const cp = store()
    acquire(cp)
    const retry = acquire(cp, { leaseId: 'lease_retry' })
    expect(retry).toMatchObject({ ok: true, duplicate: true })
    expect(retry.ok && retry.lease.leaseId).toBe('lease_1')
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
      releaseValidationLease(cp, { scopeKey: 'wt_1', leaseId: 'lease_1', nowMs: NOW + 5 })
    ).toEqual({ released: true })
    expect(assertMutationAllowed(cp, { scopeKey: 'wt_1', nowMs: NOW + 6 })).toEqual({
      allowed: true
    })
    expect(
      releaseValidationLease(cp, { scopeKey: 'wt_1', leaseId: 'lease_1', nowMs: NOW + 7 })
    ).toEqual({ released: false })
  })

  it('ignores a release from a lease id that does not own the scope', () => {
    const cp = store()
    acquire(cp)
    expect(
      releaseValidationLease(cp, { scopeKey: 'wt_1', leaseId: 'lease_other', nowMs: NOW + 5 })
    ).toEqual({ released: false })
    expect(assertMutationAllowed(cp, { scopeKey: 'wt_1', nowMs: NOW + 6 }).allowed).toBe(false)
  })

  it('scopes leases per worktree, so a separate worktree stays writable', () => {
    const cp = store()
    acquire(cp)
    expect(assertMutationAllowed(cp, { scopeKey: 'wt_2', nowMs: NOW })).toEqual({ allowed: true })
  })
})
